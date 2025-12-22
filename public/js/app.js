// =====================================================
// Jasper Image Processor - Frontend Application
// =====================================================

class ImageProcessor {
    constructor() {
        this.uploadedFiles = [];
        this.backgroundFile = null;
        this.backgroundDimensions = { width: 0, height: 0 };
        this.sessionId = null;
        
        this.initElements();
        this.bindEvents();
    }

    initElements() {
        // Upload elements
        this.dropzone = document.getElementById('dropzone');
        this.fileInput = document.getElementById('fileInput');
        this.fileList = document.getElementById('fileList');
        this.fileItems = document.getElementById('fileItems');
        this.fileCount = document.getElementById('fileCount');
        this.clearFilesBtn = document.getElementById('clearFiles');

        // Background elements
        this.bgDropzone = document.getElementById('bgDropzone');
        this.bgFileInput = document.getElementById('bgFileInput');
        this.backgroundPreview = document.getElementById('backgroundPreview');
        this.bgPreviewImage = document.getElementById('bgPreviewImage');
        this.bgPreviewName = document.getElementById('bgPreviewName');
        this.bgPreviewDimensions = document.getElementById('bgPreviewDimensions');
        this.clearBackgroundBtn = document.getElementById('clearBackground');

        // Process elements
        this.processBtn = document.getElementById('processBtn');
        this.progressSection = document.getElementById('progressSection');
        this.progressFill = document.getElementById('progressFill');
        this.progressCount = document.getElementById('progressCount');
        this.currentFile = document.getElementById('currentFile');
        this.resultsSection = document.getElementById('resultsSection');
        this.resultsSummary = document.getElementById('resultsSummary');
        this.resultsList = document.getElementById('resultsList');
    }

    bindEvents() {
        // Dropzone events
        this.dropzone.addEventListener('click', () => this.fileInput.click());
        this.dropzone.addEventListener('dragover', (e) => this.handleDragOver(e));
        this.dropzone.addEventListener('dragleave', () => this.dropzone.classList.remove('drag-over'));
        this.dropzone.addEventListener('drop', (e) => this.handleDrop(e));
        this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
        this.clearFilesBtn.addEventListener('click', () => this.clearFiles());

        // Background dropzone events
        this.bgDropzone.addEventListener('click', () => this.bgFileInput.click());
        this.bgDropzone.addEventListener('dragover', (e) => this.handleBgDragOver(e));
        this.bgDropzone.addEventListener('dragleave', () => this.bgDropzone.classList.remove('drag-over'));
        this.bgDropzone.addEventListener('drop', (e) => this.handleBgDrop(e));
        this.bgFileInput.addEventListener('change', (e) => this.handleBgFileSelect(e));
        this.clearBackgroundBtn.addEventListener('click', () => this.clearBackground());

        // Process events
        this.processBtn.addEventListener('click', () => this.startProcessing());
    }

    // =====================================================
    // File Upload Handling
    // =====================================================

    handleDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
        this.dropzone.classList.add('drag-over');
    }

    handleDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        this.dropzone.classList.remove('drag-over');
        
        const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
        this.addFiles(files);
    }

    handleFileSelect(e) {
        const files = Array.from(e.target.files);
        this.addFiles(files);
        this.fileInput.value = ''; // Reset for re-selection
    }

    addFiles(files) {
        files.forEach(file => {
            // Avoid duplicates
            if (!this.uploadedFiles.some(f => f.name === file.name && f.size === file.size)) {
                this.uploadedFiles.push(file);
            }
        });
        this.updateFileList();
        this.updateProcessButton();
    }

    updateFileList() {
        if (this.uploadedFiles.length === 0) {
            this.fileList.classList.remove('active');
            return;
        }

        this.fileList.classList.add('active');
        this.fileCount.textContent = `${this.uploadedFiles.length} file${this.uploadedFiles.length !== 1 ? 's' : ''} selected`;

        this.fileItems.innerHTML = this.uploadedFiles.map((file, index) => `
            <div class="file-item" data-index="${index}">
                <div class="file-item-icon">
                    ${this.createThumbnail(file)}
                </div>
                <div class="file-item-info">
                    <div class="file-item-name">${file.name}</div>
                    <div class="file-item-size">${this.formatFileSize(file.size)}</div>
                </div>
                <button class="file-item-remove" data-index="${index}">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M6 18L18 6M6 6l12 12"/>
                    </svg>
                </button>
            </div>
        `).join('');

        // Bind remove buttons
        this.fileItems.querySelectorAll('.file-item-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const index = parseInt(btn.dataset.index);
                this.removeFile(index);
            });
        });
    }

    createThumbnail(file) {
        const url = URL.createObjectURL(file);
        return `<img src="${url}" alt="${file.name}" onload="URL.revokeObjectURL(this.src)">`;
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    removeFile(index) {
        this.uploadedFiles.splice(index, 1);
        this.updateFileList();
        this.updateProcessButton();
    }

    clearFiles() {
        this.uploadedFiles = [];
        this.updateFileList();
        this.updateProcessButton();
    }

    // =====================================================
    // Background Image Handling
    // =====================================================

    handleBgDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
        this.bgDropzone.classList.add('drag-over');
    }

    handleBgDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        this.bgDropzone.classList.remove('drag-over');
        
        const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
        if (files.length > 0) {
            this.setBackgroundFile(files[0]);
        }
    }

    handleBgFileSelect(e) {
        const files = Array.from(e.target.files);
        if (files.length > 0) {
            this.setBackgroundFile(files[0]);
        }
        this.bgFileInput.value = '';
    }

    async setBackgroundFile(file) {
        this.backgroundFile = file;
        
        // Get dimensions using Image object
        const dimensions = await this.getImageDimensions(file);
        this.backgroundDimensions = dimensions;
        
        // Update preview
        this.updateBackgroundPreview();
        this.updateProcessButton();
    }

    getImageDimensions(file) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(img.src);
                resolve({ width: img.naturalWidth, height: img.naturalHeight });
            };
            img.onerror = () => {
                resolve({ width: 0, height: 0 });
            };
            img.src = URL.createObjectURL(file);
        });
    }

    updateBackgroundPreview() {
        if (!this.backgroundFile) {
            this.backgroundPreview.classList.remove('active');
            this.bgDropzone.style.display = '';
            return;
        }

        this.bgDropzone.style.display = 'none';
        this.backgroundPreview.classList.add('active');
        
        // Set thumbnail
        const url = URL.createObjectURL(this.backgroundFile);
        this.bgPreviewImage.innerHTML = `<img src="${url}" alt="Background" onload="URL.revokeObjectURL(this.src)">`;
        
        // Set name and dimensions
        this.bgPreviewName.textContent = this.backgroundFile.name;
        this.bgPreviewDimensions.textContent = `${this.backgroundDimensions.width} × ${this.backgroundDimensions.height} px`;
    }

    clearBackground() {
        this.backgroundFile = null;
        this.backgroundDimensions = { width: 0, height: 0 };
        this.updateBackgroundPreview();
        this.updateProcessButton();
    }

    // =====================================================
    // Processing
    // =====================================================

    updateProcessButton() {
        const canProcess = this.uploadedFiles.length > 0 && 
                           this.backgroundFile !== null;
        this.processBtn.disabled = !canProcess;
    }

    async startProcessing() {
        if (this.uploadedFiles.length === 0 || !this.backgroundFile) return;

        // First, upload foreground files and background to server
        const formData = new FormData();
        this.uploadedFiles.forEach(file => {
            formData.append('images', file);
        });
        formData.append('background', this.backgroundFile);

        try {
            this.processBtn.disabled = true;
            this.processBtn.querySelector('.btn-text').textContent = 'Uploading...';

            // Upload files
            const uploadResponse = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });

            const uploadData = await uploadResponse.json();

            if (!uploadData.success) {
                throw new Error(uploadData.error || 'Upload failed');
            }

            // Start processing
            this.processBtn.querySelector('.btn-text').textContent = 'Processing...';
            this.showProgress();

            const processResponse = await fetch('/api/process', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    files: uploadData.files,
                    backgroundFile: uploadData.backgroundFile,
                    backgroundDimensions: this.backgroundDimensions
                })
            });

            const processData = await processResponse.json();

            if (!processData.success) {
                throw new Error(processData.error || 'Processing failed');
            }

            // Store session ID for download
            this.sessionId = processData.sessionId;

            // Poll for status
            this.pollStatus();

        } catch (error) {
            console.error('Processing error:', error);
            this.showError(error.message);
            this.resetProcessButton();
        }
    }

    showProgress() {
        this.progressSection.classList.add('active');
        this.resultsSection.classList.remove('active');
    }

    async pollStatus() {
        const poll = async () => {
            try {
                const response = await fetch(`/api/status?sessionId=${this.sessionId}`);
                const status = await response.json();

                // Update progress
                const percent = status.totalImages > 0 
                    ? (status.processedImages / status.totalImages) * 100 
                    : 0;
                
                this.progressFill.style.width = `${percent}%`;
                this.progressCount.textContent = `${status.processedImages} / ${status.totalImages}`;
                this.currentFile.textContent = status.currentImage 
                    ? `Processing: ${status.currentImage}` 
                    : '';

                if (status.isProcessing) {
                    setTimeout(poll, 500);
                } else {
                    this.showResults(status.results);
                }
            } catch (error) {
                console.error('Status poll error:', error);
                setTimeout(poll, 1000);
            }
        };

        poll();
    }

    showResults(results) {
        this.progressSection.classList.remove('active');
        this.resultsSection.classList.add('active');

        const successCount = results.filter(r => r.success).length;
        const errorCount = results.filter(r => !r.success).length;

        this.resultsSummary.textContent = `${successCount} successful, ${errorCount} failed`;

        // Build results HTML with download button if there are successful results
        let resultsHTML = '';
        
        if (successCount > 0 && this.sessionId) {
            resultsHTML += `
                <div class="download-section">
                    <a href="/api/download/${this.sessionId}" class="download-btn" download>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                            <polyline points="7 10 12 15 17 10"/>
                            <line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                        <span>Download All (${successCount} ${successCount === 1 ? 'image' : 'images'})</span>
                    </a>
                </div>
            `;
        }

        resultsHTML += results.map(result => `
            <div class="result-item ${result.success ? '' : 'error'}">
                <div class="result-icon ${result.success ? 'success' : 'error'}">
                    ${result.success 
                        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>'
                        : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 18L18 6M6 6l12 12"/></svg>'
                    }
                </div>
                <div class="result-info">
                    <div class="result-name">${result.file}</div>
                    <div class="result-message">${result.success 
                        ? 'Processed successfully'
                        : result.error
                    }</div>
                </div>
            </div>
        `).join('');

        this.resultsList.innerHTML = resultsHTML;

        this.resetProcessButton();
        this.clearFiles();
        this.clearBackground();
    }

    showError(message) {
        this.progressSection.classList.remove('active');
        this.resultsSection.classList.add('active');
        this.resultsSummary.textContent = 'Error occurred';
        this.resultsList.innerHTML = `
            <div class="result-item error">
                <div class="result-icon error">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M6 18L18 6M6 6l12 12"/>
                    </svg>
                </div>
                <div class="result-info">
                    <div class="result-name">Processing Error</div>
                    <div class="result-message">${message}</div>
                </div>
            </div>
        `;
    }

    resetProcessButton() {
        this.processBtn.disabled = false;
        this.processBtn.querySelector('.btn-text').textContent = 'Start Processing';
        this.updateProcessButton();
    }
}

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
    window.imageProcessor = new ImageProcessor();
});


