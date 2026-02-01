require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const validator = require('validator');
const sanitize = require('sanitize-filename');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');
const MAX_FILE_AGE_MS = 30 * 60 * 1000; // 30 minutes

// RapidAPI Configuration - MUST be set via environment variable
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'youtube-mp36.p.rapidapi.com';

if (!RAPIDAPI_KEY) {
  console.error('ERROR: RAPIDAPI_KEY environment variable is required!');
  console.error('Set it in Render Dashboard > Environment or in .env file locally');
}

// Ensure temp directory exists
async function ensureTempDir() {
  try {
    await fs.access(TEMP_DIR);
  } catch {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  }
}
ensureTempDir();

// Clean up old temp files periodically
async function cleanupOldFiles() {
  try {
    const files = await fs.readdir(TEMP_DIR);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = await fs.stat(filePath);
      if (now - stats.mtimeMs > MAX_FILE_AGE_MS) {
        await fs.unlink(filePath);
      }
    }
  } catch (error) {
    console.error('Cleanup error:', error.message);
  }
}
setInterval(cleanupOldFiles, 10 * 60 * 1000);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Helper function to make RapidAPI requests
function rapidApiRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      method: 'GET',
      hostname: RAPIDAPI_HOST,
      port: null,
      path: path,
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      }
    };

    console.log('Making request to:', RAPIDAPI_HOST + path);

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString();
          console.log('API Response:', body.substring(0, 500));
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Failed to parse API response: ' + e.message));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

// Extract video ID from various YouTube URL formats
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// Download file from URL
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = require('fs').createWriteStream(destPath);

    const makeRequest = (downloadUrl, redirectCount = 0) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      const protocol = downloadUrl.startsWith('https') ? https : require('http');

      protocol.get(downloadUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          makeRequest(response.headers.location, redirectCount + 1);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Download failed with status ${response.statusCode}`));
          return;
        }

        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (err) => {
        require('fs').unlink(destPath, () => { });
        reject(err);
      });
    };

    makeRequest(url);
  });
}

// API endpoint to get video info
app.get('/api/info', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  try {
    console.log('Getting video info for:', videoId);
    const result = await rapidApiRequest(`/dl?id=${videoId}`);

    if (result.status === 'fail' || result.error) {
      return res.status(400).json({ error: result.msg || 'Could not fetch video info' });
    }

    res.json({
      title: result.title || 'Unknown Title',
      author: result.author || result.channel || 'Unknown Artist',
      duration: result.duration || 0,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    });
  } catch (error) {
    console.error('Info error:', error);
    res.status(500).json({ error: 'Failed to get video info' });
  }
});

// API endpoint to convert and download
app.get('/api/convert', async (req, res) => {
  const { url } = req.query;

  if (!url || !validator.isURL(url, { protocols: ['http', 'https'], require_protocol: true })) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({ error: 'Could not extract video ID from URL' });
  }

  try {
    console.log('Converting video:', videoId);
    const result = await rapidApiRequest(`/dl?id=${videoId}`);

    if (result.status === 'fail') {
      return res.status(400).json({ error: result.msg || 'Conversion failed' });
    }

    let downloadUrl = result.link;
    let title = result.title || 'audio';

    if (!downloadUrl) {
      return res.status(400).json({ error: 'Could not get download link' });
    }

    const safeTitle = sanitize(title).substring(0, 100) || 'audio';
    const filename = `${safeTitle}.mp3`;
    const tempPath = path.join(TEMP_DIR, `${Date.now()}-${Math.random().toString(36).substring(7)}.mp3`);

    await downloadFile(downloadUrl, tempPath);

    const stats = await fs.stat(tempPath);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Length', stats.size);

    const readStream = require('fs').createReadStream(tempPath);
    readStream.pipe(res);

    readStream.on('close', async () => {
      try { await fs.unlink(tempPath); } catch (e) { }
    });

  } catch (error) {
    console.error('Conversion error:', error.message);
    res.status(500).json({ error: 'Conversion failed. Please try again.' });
  }
});

// Serve static frontend - NO LOGIN REQUIRED
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YouTube to MP3 Converter</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    
    .container {
      background: rgba(255, 255, 255, 0.95);
      border-radius: 24px;
      padding: 40px;
      width: 100%;
      max-width: 500px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    }
    
    h1 {
      font-size: 28px;
      font-weight: 700;
      color: #1a1a2e;
      margin-bottom: 8px;
      text-align: center;
    }
    
    .subtitle {
      color: #666;
      text-align: center;
      margin-bottom: 32px;
    }
    
    .form-group { margin-bottom: 20px; }
    
    label {
      display: block;
      font-size: 14px;
      font-weight: 500;
      color: #374151;
      margin-bottom: 8px;
    }
    
    input[type="text"] {
      width: 100%;
      padding: 14px 16px;
      border: 2px solid #e5e7eb;
      border-radius: 12px;
      font-size: 16px;
      transition: all 0.2s;
    }
    
    input:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }
    
    button {
      width: 100%;
      padding: 16px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    
    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
    }
    
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    
    .video-info {
      display: none;
      background: #f8fafc;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 20px;
    }
    
    .video-info.show {
      display: flex;
      gap: 16px;
      align-items: center;
    }
    
    .video-info img {
      width: 120px;
      height: 68px;
      border-radius: 8px;
      object-fit: cover;
    }
    
    .video-meta h3 {
      font-size: 14px;
      font-weight: 600;
      color: #1a1a2e;
      margin-bottom: 4px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    
    .video-meta p { font-size: 12px; color: #666; }
    
    .error, .success {
      padding: 12px 16px;
      border-radius: 8px;
      margin-bottom: 16px;
      font-size: 14px;
      display: none;
    }
    
    .error { background: #fee2e2; color: #dc2626; }
    .success { background: #d1fae5; color: #059669; }
    .error.show, .success.show { display: block; }
    
    .loading {
      display: none;
      text-align: center;
      padding: 20px;
    }
    
    .loading.show { display: block; }
    
    .spinner {
      width: 40px;
      height: 40px;
      border: 4px solid #e5e7eb;
      border-top-color: #667eea;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 12px;
    }
    
    @keyframes spin { to { transform: rotate(360deg); } }
    
    .footer {
      text-align: center;
      margin-top: 24px;
      font-size: 12px;
      color: #9ca3af;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎵 YouTube to MP3</h1>
    <p class="subtitle">Convert YouTube videos to MP3 audio</p>
    
    <div class="error" id="error"></div>
    <div class="success" id="success"></div>
    
    <div class="form-group">
      <label for="url">YouTube URL</label>
      <input type="text" id="url" placeholder="https://youtube.com/watch?v=...">
    </div>
    
    <div class="video-info" id="videoInfo">
      <img id="thumbnail" src="" alt="Video thumbnail">
      <div class="video-meta">
        <h3 id="videoTitle"></h3>
        <p id="videoAuthor"></p>
      </div>
    </div>
    
    <div class="loading" id="loading">
      <div class="spinner"></div>
      <p>Converting... Please wait</p>
    </div>
    
    <button type="button" id="convertBtn">Convert to MP3</button>
    
    <div class="footer">
      <p>For personal use only</p>
    </div>
  </div>
  
  <script>
    let debounceTimer;
    document.getElementById('url').addEventListener('input', function() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(fetchVideoInfo, 500);
    });
    
    async function fetchVideoInfo() {
      const url = document.getElementById('url').value.trim();
      const videoInfoEl = document.getElementById('videoInfo');
      
      if (!url || (!url.includes('youtube') && !url.includes('youtu.be'))) {
        videoInfoEl.classList.remove('show');
        return;
      }
      
      try {
        const res = await fetch('/api/info?url=' + encodeURIComponent(url));
        const data = await res.json();
        
        if (data.title) {
          document.getElementById('thumbnail').src = data.thumbnail || '';
          document.getElementById('videoTitle').textContent = data.title;
          document.getElementById('videoAuthor').textContent = data.author;
          videoInfoEl.classList.add('show');
        } else {
          videoInfoEl.classList.remove('show');
        }
      } catch (err) {
        videoInfoEl.classList.remove('show');
      }
    }
    
    async function convert() {
      const url = document.getElementById('url').value.trim();
      const errorEl = document.getElementById('error');
      const successEl = document.getElementById('success');
      const loadingEl = document.getElementById('loading');
      const convertBtn = document.getElementById('convertBtn');
      
      if (!url) {
        errorEl.textContent = 'Please enter a YouTube URL';
        errorEl.classList.add('show');
        return;
      }
      
      errorEl.classList.remove('show');
      successEl.classList.remove('show');
      loadingEl.classList.add('show');
      convertBtn.disabled = true;
      
      try {
        const response = await fetch('/api/convert?url=' + encodeURIComponent(url));
        
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Conversion failed');
        }
        
        const disposition = response.headers.get('Content-Disposition');
        let filename = 'audio.mp3';
        if (disposition) {
          const match = disposition.match(/filename\\*?=['"]?(?:UTF-8'')?([^;'"]+)/i);
          if (match) filename = decodeURIComponent(match[1]);
        }
        
        const blob = await response.blob();
        const downloadLink = document.createElement('a');
        downloadLink.href = URL.createObjectURL(blob);
        downloadLink.download = filename;
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);
        URL.revokeObjectURL(downloadLink.href);
        
        successEl.textContent = 'Download started! Check your downloads folder.';
        successEl.classList.add('show');
        
      } catch (err) {
        errorEl.textContent = err.message || 'Conversion failed. Please try again.';
        errorEl.classList.add('show');
      } finally {
        loadingEl.classList.remove('show');
        convertBtn.disabled = false;
      }
    }
    
    document.getElementById('url').addEventListener('keypress', function(e) {
      if (e.key === 'Enter') convert();
    });
    
    document.getElementById('convertBtn').addEventListener('click', function(e) {
      e.preventDefault();
      convert();
    });
  </script>
</body>
</html>
  `);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to use the converter`);
});
