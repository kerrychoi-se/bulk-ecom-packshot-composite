require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const sharp = require('sharp');
const archiver = require('archiver');
const crypto = require('crypto');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;

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
}

function generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
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

// Store processing state
let processingState = {
    isProcessing: false,
    totalImages: 0,
    processedImages: 0,
    currentImage: '',
    results: [],
    sessionId: null
};

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

    // Initialize processing state
    processingState = {
        isProcessing: true,
        totalImages: files.length,
        processedImages: 0,
        currentImage: '',
        results: [],
        sessionId: sessionId
    };

    // Process asynchronously with background
    processImages(files, backgroundFile, backgroundDimensions, sessionDir);

    res.json({
        success: true,
        message: `Started processing ${files.length} images`,
        totalImages: files.length,
        sessionId: sessionId
    });
});

// Get processing status
app.get('/api/status', (req, res) => {
    res.json(processingState);
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

// Jasper.ai Packshot Compositing API integration
async function processWithJasper(foregroundPath, backgroundPath, bgDimensions, originalFilename) {
    const apiKey = process.env.JASPER_API_KEY;
    
    if (!apiKey) {
        return {
            success: false,
            error: 'JASPER_API_KEY not configured in .env file'
        };
    }

    try {
        // Calculate max dimensions to stay under 5MP limit with some safety margin
        const safeMaxPixels = MAX_MEGAPIXELS * 0.9; // 4.5MP for safety margin
        
        // First, calculate the final output dimensions (respecting 5MP limit)
        let finalOutputWidth = bgDimensions.width;
        let finalOutputHeight = bgDimensions.height;
        const bgPixels = finalOutputWidth * finalOutputHeight;
        if (bgPixels > safeMaxPixels) {
            const scale = Math.sqrt(safeMaxPixels / bgPixels);
            finalOutputWidth = Math.floor(finalOutputWidth * scale);
            finalOutputHeight = Math.floor(finalOutputHeight * scale);
        }
        
        // Downscale foreground to fit within FINAL output dimensions
        const foregroundBuffer = await downscaleImageToLimit(
            foregroundPath, 
            finalOutputWidth,
            finalOutputHeight,
            safeMaxPixels
        );

        // Downscale background to the same final output dimensions
        const backgroundBuffer = await downscaleImageToLimit(
            backgroundPath,
            finalOutputWidth,
            finalOutputHeight,
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

        // Call Jasper.ai Packshot Compositing API
        const apiEndpoint = 'https://api.jasper.ai/v1/image/packshot-compositing';
        const response = await axios.post(
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

// Process all images
async function processImages(files, backgroundFile, bgDimensions, outputDirectory) {
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        processingState.currentImage = file.originalName;

        try {
            // Process with Jasper.ai Packshot Compositing
            const result = await processWithJasper(file.path, backgroundFile.path, bgDimensions, file.originalName);

            if (!result.success) {
                throw new Error(result.error || 'Processing failed');
            }

            // Save the processed image
            if (result.imageData) {
                const outputFilename = `composited-${file.originalName}`;
                const outputPath = path.join(outputDirectory, outputFilename);
                fs.writeFileSync(outputPath, result.imageData);
                result.savedTo = outputPath;
            }

            processingState.results.push({
                file: file.originalName,
                success: true,
                result: { savedTo: result.savedTo }
            });

        } catch (error) {
            console.error(`Error processing ${file.originalName}:`, error);
            processingState.results.push({
                file: file.originalName,
                success: false,
                error: error.message
            });
        }

        processingState.processedImages = i + 1;
    }

    processingState.isProcessing = false;
    processingState.currentImage = '';

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
    // Cleanup old session if exists
    if (processingState.sessionId) {
        cleanupSession(processingState.sessionId);
    }
    
    processingState = {
        isProcessing: false,
        totalImages: 0,
        processedImages: 0,
        currentImage: '',
        results: [],
        sessionId: null
    };
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
║                                                            ║
╚════════════════════════════════════════════════════════════╝
    `);
});
