# Jasper Image Processor

A locally hosted web application for batch compositing product images onto backgrounds using Jasper.ai's Packshot Compositing API.

## Features

- 📤 **Drag & Drop Upload**: Easily upload multiple foreground images at once
- 🖼️ **Background Selection**: Upload a custom background image for compositing
- ⚡ **Parallel Processing**: Process 3 images concurrently for faster batch completion
- 🔁 **Automatic Retries**: Exponential backoff retry mechanism for resilient API calls
- 📊 **Real-time Progress**: Track processing status with live updates
- 📥 **Zip Download**: Download all processed images as a convenient zip file
- 🎨 **Modern UI**: Beautiful, dark-themed interface with smooth animations
- 🧹 **Auto-cleanup**: Automatic session cleanup after 1 hour
- 🧠 **Memory Optimized**: Chunked processing for efficient memory usage with large batches

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create a `.env` file in the project root:

```env
JASPER_API_KEY=your_api_key_here
PORT=3000
```

### 3. Start the Server

```bash
npm start
```

### 4. Open in Browser

Navigate to [http://localhost:3000](http://localhost:3000)

## Usage

1. **Upload Foreground Images**: Drag and drop product images onto the first upload zone, or click to browse
2. **Select Background**: Upload a single background image that will be used for all composites
3. **Process**: Click "Start Processing" to composite each foreground onto the background using Jasper.ai
4. **Download**: Once complete, download all processed images as a zip file

## How It Works

The application uses Jasper.ai's **Packshot Compositing API** to intelligently composite product/foreground images onto a background. The API:

- Automatically removes the foreground image background
- Places the subject onto your custom background
- Maintains proper proportions and positioning

### Image Requirements

- **Supported formats**: JPEG, PNG, WebP
- **Max file size**: 50MB per image
- **Max resolution**: Images are automatically downscaled to stay under Jasper's 5 megapixel limit

## Project Structure

```
├── server.js              # Express backend server with Jasper.ai integration
├── package.json           # Dependencies and scripts
├── .env                   # Environment configuration (create this)
├── .gitignore             # Git ignore rules
├── public/
│   ├── index.html         # Main HTML page
│   ├── css/
│   │   └── styles.css     # Dark-themed styling
│   └── js/
│       └── app.js         # Frontend JavaScript (ImageProcessor class)
├── uploads/               # Temporary upload directory (auto-created)
└── temp/                  # Session output directory (auto-created, auto-cleaned)
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/upload` | POST | Upload foreground images and background |
| `/api/process` | POST | Start batch image processing |
| `/api/status?sessionId=<id>` | GET | Get processing status for a session |
| `/api/download/:sessionId` | GET | Download processed images as zip |
| `/api/clear` | POST | Clear processing results and cleanup session |

## Tech Stack

- **Backend**: Node.js, Express
- **Image Processing**: Sharp (for resizing/optimization)
- **Archive**: Archiver (for zip downloads)
- **Frontend**: Vanilla JavaScript, CSS3
- **File Handling**: Multer
- **HTTP Client**: Axios
- **Concurrency Control**: p-limit (for parallel processing)

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `JASPER_API_KEY` | Your Jasper.ai API key | Required |
| `PORT` | Server port | 3000 |

### Processing Limits

- Session timeout: 1 hour (auto-cleanup)
- Max megapixels: 5MP (Jasper API limit)
- API timeout: 2 minutes per image
- **Parallel concurrency**: 3 images processed simultaneously
- **Chunk size**: 10 images per memory chunk
- **Max retries**: 3 attempts with exponential backoff (4s, 8s, 16s delays)

## Troubleshooting

### "JASPER_API_KEY not configured" error
Create a `.env` file with your API key:
```env
JASPER_API_KEY=your_actual_key_here
```

### Images are being downscaled
Large images are automatically resized to stay under Jasper's 5 megapixel limit. This is handled automatically and logged to the console.

### Processing takes a long time
Each image takes up to 2 minutes to process with the Jasper API. However, with parallel processing (3 concurrent), large batches are now significantly faster than sequential processing.

### API rate limiting or errors
The application automatically retries failed API calls up to 3 times with exponential backoff (4s, 8s, 16s delays). This handles temporary network issues, rate limits (429), and server errors (5xx).

### Memory usage with large batches
Images are processed in chunks of 10 to optimize memory usage. The background image is pre-loaded once per chunk rather than per-image, reducing memory overhead.

## License

MIT
