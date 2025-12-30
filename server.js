const { execSync } = require('child_process');
const path = require('path');

// Self-healing .env loader - automatically fixes macOS extended attribute issues
const envPath = path.join(__dirname, '.env');
let dotenvResult = require('dotenv').config();

if (dotenvResult.error?.code === 'EPERM' && require('fs').existsSync(envPath)) {
    console.log('⚠️  Fixing .env file permissions...');
    try {
        execSync(`xattr -c "${envPath}"`);
        dotenvResult = require('dotenv').config({ override: true });
        console.log('✓ Fixed! Continuing startup...');
    } catch (e) {
        console.error('❌ Could not fix .env permissions. Run manually: xattr -c .env');
        process.exit(1);
    }
}

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const axios = require('axios');
const sharp = require('sharp');
const archiver = require('archiver');
const crypto = require('crypto');
const FormData = require('form-data');
const pLimit = require('p-limit').default;

const app = express();
const PORT = process.env.PORT || 3000;

// Processing configuration
const CONCURRENCY_LIMIT = 3;  // Parallel API calls
const CHUNK_SIZE = 10;        // Images per memory chunk
const MAX_RETRIES = 3;        // Retry attempts for failed API calls
const RETRY_BASE_DELAY = 2000; // Base delay for exponential backoff (ms)

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Ensure temp directory exists for session-based outputs
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

// Track active sessions for cleanup
const activeSessions = new Map();
const SESSION_TIMEOUT = 60 * 60 * 1000; // 1 hour

// Per-session processing states (fixes race condition)
const sessionStates = new Map();

function getSessionState(sessionId) {
    if (!sessionStates.has(sessionId)) {
        sessionStates.set(sessionId, {
            isProcessing: false,
            totalImages: 0,
            processedImages: 0,
            currentImages: [],  // Track multiple concurrent images
            results: []
        });
    }
    return sessionStates.get(sessionId);
}

function cleanupSessionState(sessionId) {
    sessionStates.delete(sessionId);
}

// Cleanup old sessions periodically
setInterval(() => {
    const now = Date.now();
    for (const [sessionId, sessionData] of activeSessions.entries()) {
        if (now - sessionData.createdAt > SESSION_TIMEOUT) {
            cleanupSession(sessionId);
        }
    }
}, 5 * 60 * 1000); // Check every 5 minutes

function cleanupSession(sessionId) {
    const sessionDir = path.join(tempDir, sessionId);
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        console.log(`Cleaned up session: ${sessionId}`);
    }
    activeSessions.delete(sessionId);
    cleanupSessionState(sessionId);
}

function generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
}

// Utility: sleep for exponential backoff
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry mechanism with exponential backoff
function isRetryableError(error) {
    // Retry on network errors, timeouts, rate limits (429), and server errors (5xx)
    if (!error.response) {
        // Network error or timeout
        return true;
    }
    const status = error.response.status;
    return status === 429 || status >= 500;
}

async function withRetry(fn, context = '', maxRetries = MAX_RETRIES) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            
            if (!isRetryableError(error) || attempt === maxRetries) {
                throw error;
            }
            
            const delay = Math.pow(2, attempt) * RETRY_BASE_DELAY; // 4s, 8s, 16s
            console.log(`[Retry ${attempt}/${maxRetries}] ${context} - Retrying in ${delay}ms...`);
            await sleep(delay);
        }
    }
    
    throw lastError;
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const fileFilter = (req, file, cb) => {
    // Jasper API supports: jpeg, png, webp
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only JPEG, PNG, and WebP images are allowed.'), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit per file
});

// Configure upload fields for foreground images and background
const uploadFields = upload.fields([
    { name: 'images', maxCount: 100 },
    { name: 'background', maxCount: 1 }
]);

// API Routes

// Upload foreground images and background
app.post('/api/upload', uploadFields, (req, res) => {
    try {
        const foregroundFiles = req.files['images'] || [];
        const backgroundFiles = req.files['background'] || [];

        if (foregroundFiles.length === 0) {
            return res.status(400).json({ error: 'No foreground images uploaded' });
        }

        if (backgroundFiles.length === 0) {
            return res.status(400).json({ error: 'No background image uploaded' });
        }

        const fileInfo = foregroundFiles.map(file => ({
            id: path.parse(file.filename).name,
            originalName: file.originalname,
            filename: file.filename,
            path: file.path,
            size: file.size,
            mimetype: file.mimetype
        }));

        const backgroundFile = backgroundFiles[0];
        const backgroundInfo = {
            id: path.parse(backgroundFile.filename).name,
            originalName: backgroundFile.originalname,
            filename: backgroundFile.filename,
            path: backgroundFile.path,
            size: backgroundFile.size,
            mimetype: backgroundFile.mimetype
        };

        res.json({
            success: true,
            message: `${foregroundFiles.length} foreground image(s) and 1 background uploaded successfully`,
            files: fileInfo,
            backgroundFile: backgroundInfo
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed: ' + error.message });
    }
});


// Process images with Jasper.ai
app.post('/api/process', async (req, res) => {
    const { files, backgroundFile, backgroundDimensions } = req.body;

    if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files to process' });
    }

    if (!backgroundFile) {
        return res.status(400).json({ error: 'No background image specified' });
    }

    // Generate a unique session ID for this batch
    const sessionId = generateSessionId();
    const sessionDir = path.join(tempDir, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Track this session
    activeSessions.set(sessionId, {
        createdAt: Date.now(),
        fileCount: files.length
    });

    // Initialize per-session processing state
    const state = getSessionState(sessionId);
    state.isProcessing = true;
    state.totalImages = files.length;
    state.processedImages = 0;
    state.currentImages = [];
    state.results = [];

    // Process asynchronously with background
    processImagesParallel(files, backgroundFile, backgroundDimensions, sessionDir, sessionId);

    res.json({
        success: true,
        message: `Started processing ${files.length} images`,
        totalImages: files.length,
        sessionId: sessionId
    });
});

// Get processing status (now requires sessionId)
app.get('/api/status', (req, res) => {
    const { sessionId } = req.query;
    
    if (!sessionId) {
        // Backwards compatibility: return empty state if no sessionId
        return res.json({
            isProcessing: false,
            totalImages: 0,
            processedImages: 0,
            currentImages: [],
            results: []
        });
    }
    
    const state = getSessionState(sessionId);
    res.json({
        ...state,
        // For backwards compatibility, include currentImage as string
        currentImage: state.currentImages.length > 0 ? state.currentImages.join(', ') : ''
    });
});

// Download processed images as zip
app.get('/api/download/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const sessionDir = path.join(tempDir, sessionId);

    // Validate session exists
    if (!fs.existsSync(sessionDir)) {
        return res.status(404).json({ error: 'Session not found or expired' });
    }

    // Get list of files in session directory
    const files = fs.readdirSync(sessionDir).filter(f => !f.startsWith('.'));
    
    if (files.length === 0) {
        return res.status(404).json({ error: 'No files found in session' });
    }

    // Set response headers for zip download
    const timestamp = new Date().toISOString().slice(0, 10);
    const zipFilename = `processed-images-${timestamp}.zip`;
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

    // Create archive
    const archive = archiver('zip', {
        zlib: { level: 6 } // Balanced compression
    });

    // Handle archive errors
    archive.on('error', (err) => {
        console.error('Archive error:', err);
        res.status(500).json({ error: 'Failed to create zip file' });
    });

    // When archive is finalized, cleanup the session
    archive.on('end', () => {
        console.log(`Zip download complete for session: ${sessionId}`);
        // Cleanup after a short delay to ensure download completes
        setTimeout(() => {
            cleanupSession(sessionId);
        }, 5000);
    });

    // Pipe archive to response
    archive.pipe(res);

    // Add files to archive
    for (const file of files) {
        const filePath = path.join(sessionDir, file);
        archive.file(filePath, { name: file });
    }

    // Finalize archive
    archive.finalize();
});

// Downscale image to fit within max dimensions AND megapixel limit
// Jasper API limit: 5 megapixels per image
const MAX_MEGAPIXELS = 5000000;

async function downscaleImageToLimit(imagePath, maxWidth, maxHeight, maxPixels) {
    const metadata = await sharp(imagePath).metadata();
    let { width, height } = metadata;
    const currentPixels = width * height;
    
    // Calculate scale needed for dimension constraints (if provided)
    let dimensionScale = 1;
    if (maxWidth && maxHeight) {
        if (width > maxWidth || height > maxHeight) {
            const scaleX = maxWidth / width;
            const scaleY = maxHeight / height;
            dimensionScale = Math.min(scaleX, scaleY);
        }
    }
    
    // Calculate scale needed for megapixel limit
    let pixelScale = 1;
    if (currentPixels > maxPixels) {
        pixelScale = Math.sqrt(maxPixels / currentPixels);
    }
    
    // Use the smaller scale (more aggressive downscale)
    const scale = Math.min(dimensionScale, pixelScale);
    
    // Check if any downscaling is needed
    if (scale >= 1) {
        // No downscaling needed
        return fs.readFileSync(imagePath);
    }
    
    const newWidth = Math.floor(width * scale);
    const newHeight = Math.floor(height * scale);
    const newPixels = newWidth * newHeight;
    const megapixels = (newPixels / 1000000).toFixed(2);
    
    console.log(`Downscaling image from ${width}x${height} (${(currentPixels/1000000).toFixed(2)}MP) to ${newWidth}x${newHeight} (${megapixels}MP)`);
    
    // Downscale and return buffer
    // Use .rotate() without arguments to auto-orient based on EXIF data
    return await sharp(imagePath)
        .rotate()
        .resize(newWidth, newHeight, { fit: 'inside' })
        .toBuffer();
}

// Pre-load and cache background buffer for a chunk
async function loadBackgroundBuffer(backgroundPath, bgDimensions) {
    const safeMaxPixels = MAX_MEGAPIXELS * 0.9;
    
    let finalOutputWidth = bgDimensions.width;
    let finalOutputHeight = bgDimensions.height;
    const bgPixels = finalOutputWidth * finalOutputHeight;
    if (bgPixels > safeMaxPixels) {
        const scale = Math.sqrt(safeMaxPixels / bgPixels);
        finalOutputWidth = Math.floor(finalOutputWidth * scale);
        finalOutputHeight = Math.floor(finalOutputHeight * scale);
    }
    
    const backgroundBuffer = await downscaleImageToLimit(
        backgroundPath,
        finalOutputWidth,
        finalOutputHeight,
        safeMaxPixels
    );
    
    return {
        buffer: backgroundBuffer,
        finalWidth: finalOutputWidth,
        finalHeight: finalOutputHeight,
        safeMaxPixels
    };
}

// Jasper.ai Packshot Compositing API integration (with pre-loaded background)
async function processWithJasperOptimized(foregroundPath, backgroundData, originalFilename) {
    const apiKey = process.env.JASPER_API_KEY;
    
    if (!apiKey) {
        return {
            success: false,
            error: 'JASPER_API_KEY not configured in .env file'
        };
    }

    try {
        const { buffer: backgroundBuffer, finalWidth, finalHeight, safeMaxPixels } = backgroundData;
        
        // Downscale foreground to fit within FINAL output dimensions
        const foregroundBuffer = await downscaleImageToLimit(
            foregroundPath, 
            finalWidth,
            finalHeight,
            safeMaxPixels
        );

        // Create form data with file buffers (Jasper API expects multipart/form-data)
        const formData = new FormData();
        formData.append('image_file', foregroundBuffer, {
            filename: 'foreground.jpg',
            contentType: 'image/jpeg'
        });
        formData.append('background_image_file', backgroundBuffer, {
            filename: 'background.jpg',
            contentType: 'image/jpeg'
        });

        // Call Jasper.ai Packshot Compositing API with retry
        const apiEndpoint = 'https://api.jasper.ai/v1/image/packshot-compositing';
        
        const response = await withRetry(
            () => axios.post(
                apiEndpoint,
                formData,
                {
                    headers: {
                        'x-api-key': apiKey,
                        ...formData.getHeaders()
                    },
                    timeout: 120000, // 2 minute timeout
                    responseType: 'arraybuffer'  // Receive as binary buffer
                }
            ),
            `Processing ${originalFilename}`
        );

        // Response is raw JPEG binary data
        const imageBuffer = Buffer.from(response.data);
        return {
            success: true,
            imageData: imageBuffer,
            response: { size: imageBuffer.length }
        };

    } catch (error) {
        console.error('Jasper API error:', error.response?.data || error.message);
        // Extract error message from Jasper's response format
        let errorMessage = error.message;
        if (error.response?.data) {
            // If response is arraybuffer, convert to string to check for error
            try {
                const errorData = JSON.parse(Buffer.from(error.response.data).toString());
                if (errorData.errors && Array.isArray(errorData.errors) && errorData.errors.length > 0) {
                    errorMessage = `Jasper API: ${errorData.errors.join(', ')}`;
                } else if (errorData.message) {
                    errorMessage = `Jasper API: ${errorData.message}`;
                }
            } catch (e) {
                // Response wasn't JSON, use original error message
            }
        }
        return {
            success: false,
            error: errorMessage
        };
    }
}

// Process a single image (used by parallel processor)
async function processSingleImage(file, backgroundData, outputDirectory, state) {
    const fileName = file.originalName;
    
    // Track this image as being processed
    state.currentImages.push(fileName);
    
    try {
        // Process with Jasper.ai Packshot Compositing (with retry built-in)
        const result = await processWithJasperOptimized(file.path, backgroundData, fileName);

        if (!result.success) {
            throw new Error(result.error || 'Processing failed');
        }

        // Save the processed image
        if (result.imageData) {
            const outputFilename = `composited-${fileName}`;
            const outputPath = path.join(outputDirectory, outputFilename);
            fs.writeFileSync(outputPath, result.imageData);
            result.savedTo = outputPath;
        }

        state.results.push({
            file: fileName,
            success: true,
            result: { savedTo: result.savedTo }
        });

        console.log(`✓ Processed: ${fileName}`);

    } catch (error) {
        console.error(`✗ Error processing ${fileName}:`, error.message);
        state.results.push({
            file: fileName,
            success: false,
            error: error.message
        });
    } finally {
        // Remove from current images being processed
        const idx = state.currentImages.indexOf(fileName);
        if (idx > -1) {
            state.currentImages.splice(idx, 1);
        }
        
        // Increment processed count
        state.processedImages++;
    }
}

// Process all images with parallel execution and chunked memory management
async function processImagesParallel(files, backgroundFile, bgDimensions, outputDirectory, sessionId) {
    const state = getSessionState(sessionId);
    const limit = pLimit(CONCURRENCY_LIMIT);
    
    console.log(`\n📦 Starting batch processing: ${files.length} images`);
    console.log(`   Concurrency: ${CONCURRENCY_LIMIT}, Chunk size: ${CHUNK_SIZE}, Max retries: ${MAX_RETRIES}\n`);
    
    // Process in chunks for memory efficiency
    for (let chunkStart = 0; chunkStart < files.length; chunkStart += CHUNK_SIZE) {
        const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, files.length);
        const chunk = files.slice(chunkStart, chunkEnd);
        const chunkNum = Math.floor(chunkStart / CHUNK_SIZE) + 1;
        const totalChunks = Math.ceil(files.length / CHUNK_SIZE);
        
        console.log(`📂 Processing chunk ${chunkNum}/${totalChunks} (${chunk.length} images)`);
        
        // Pre-load background buffer once per chunk (memory optimization)
        let backgroundData;
        try {
            backgroundData = await loadBackgroundBuffer(backgroundFile.path, bgDimensions);
        } catch (error) {
            console.error('Failed to load background image:', error);
            // Mark all images in chunk as failed
            for (const file of chunk) {
                state.results.push({
                    file: file.originalName,
                    success: false,
                    error: 'Failed to load background image'
                });
                state.processedImages++;
            }
            continue;
        }
        
        // Process chunk in parallel with concurrency limit
        const promises = chunk.map(file => 
            limit(() => processSingleImage(file, backgroundData, outputDirectory, state))
        );
        
        await Promise.all(promises);
        
        // Clear background buffer reference to help GC
        backgroundData = null;
        
        console.log(`   Chunk ${chunkNum} complete. Progress: ${state.processedImages}/${state.totalImages}\n`);
    }

    state.isProcessing = false;
    state.currentImages = [];

    // Summary
    const successCount = state.results.filter(r => r.success).length;
    const errorCount = state.results.filter(r => !r.success).length;
    console.log(`\n✅ Batch complete: ${successCount} successful, ${errorCount} failed\n`);

    // Cleanup uploaded files after processing
    const filesToCleanup = [...files, backgroundFile];
    for (const file of filesToCleanup) {
        try {
            if (fs.existsSync(file.path)) {
                fs.unlinkSync(file.path);
            }
        } catch (err) {
            console.error('Error cleaning up file:', err);
        }
    }
}

// Clear results
app.post('/api/clear', (req, res) => {
    const { sessionId } = req.body;
    
    if (sessionId) {
        cleanupSession(sessionId);
    }
    
    res.json({ success: true });
});


// Start server
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🖼️  Jasper Image Processor                               ║
║                                                            ║
║   Server running at: http://localhost:${PORT}                 ║
║                                                            ║
║   Ready to process images!                                 ║
║   - Parallel processing: ${CONCURRENCY_LIMIT} concurrent                      ║
║   - Chunk size: ${CHUNK_SIZE} images                                 ║
║   - Retries: ${MAX_RETRIES} with exponential backoff                   ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
    `);
});
