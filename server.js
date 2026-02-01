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

// RapidAPI Configuration
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'f843e7c874msh85435a209eaf50fp1c599ajsncaafbe28694f';
const RAPIDAPI_HOST = 'youtube-mp3-audio-video-downloader.p.rapidapi.com';

// Authentication - single password for private use
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'mihir123';

// Store authenticated sessions (in production, use Redis or similar)
const sessions = new Map();

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
setInterval(cleanupOldFiles, 10 * 60 * 1000); // Run every 10 minutes

// Security middleware with relaxed CSP for our needs
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
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Session middleware
function generateSessionId() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function isAuthenticated(req) {
  const sessionId = req.headers['x-session-id'] || req.query.sessionId;
  return sessions.has(sessionId);
}

// Authentication endpoint
app.post('/api/auth', (req, res) => {
  const { password } = req.body;

  if (password === AUTH_PASSWORD) {
    const sessionId = generateSessionId();
    sessions.set(sessionId, { createdAt: Date.now() });

    // Clean up old sessions
    for (const [sid, data] of sessions) {
      if (Date.now() - data.createdAt > 24 * 60 * 60 * 1000) {
        sessions.delete(sid);
      }
    }

    res.json({ success: true, sessionId });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

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

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString();
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Failed to parse API response'));
        }
      });
    });

    req.on('error', reject);
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

    const makeRequest = (downloadUrl) => {
      const protocol = downloadUrl.startsWith('https') ? https : require('http');

      protocol.get(downloadUrl, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          makeRequest(response.headers.location);
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
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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

    // Get video details from RapidAPI
    const result = await rapidApiRequest(`/video_details?id=${videoId}`);

    if (result.error || !result.title) {
      console.error('API Error:', result);
      return res.status(400).json({ error: 'Could not fetch video info. Please try a different video.' });
    }

    res.json({
      title: result.title || 'Unknown Title',
      author: result.channel?.name || result.author || 'Unknown Artist',
      duration: result.duration || result.lengthSeconds || 0,
      thumbnail: result.thumbnail?.[0]?.url || result.thumbnails?.[0]?.url || ''
    });
  } catch (error) {
    console.error('Info error:', error);
    res.status(500).json({ error: 'Failed to get video info' });
  }
});

// API endpoint to convert and download
app.get('/api/convert', async (req, res) => {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { url, quality = '128' } = req.query;

  if (!url || !validator.isURL(url, { protocols: ['http', 'https'], require_protocol: true })) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({ error: 'Could not extract video ID from URL' });
  }

  try {
    console.log('Converting video:', videoId);

    // Step 1: Get download link from RapidAPI
    const result = await rapidApiRequest(`/download?id=${videoId}&format=mp3&quality=${quality}kbps`);

    console.log('API Response:', JSON.stringify(result).substring(0, 500));

    // Check for different response formats
    let downloadUrl = null;
    let title = 'audio';

    if (result.link) {
      downloadUrl = result.link;
      title = result.title || 'audio';
    } else if (result.url) {
      downloadUrl = result.url;
      title = result.title || 'audio';
    } else if (result.downloadUrl) {
      downloadUrl = result.downloadUrl;
      title = result.title || 'audio';
    } else if (result.audio) {
      // Some APIs return audio in a nested object
      downloadUrl = result.audio.url || result.audio.link;
      title = result.title || 'audio';
    } else if (result.formats) {
      // Find audio format
      const audioFormat = result.formats.find(f => f.mimeType?.includes('audio') || f.format === 'mp3');
      if (audioFormat) {
        downloadUrl = audioFormat.url || audioFormat.link;
        title = result.title || 'audio';
      }
    }

    if (!downloadUrl) {
      console.error('No download URL found in response:', result);
      return res.status(400).json({
        error: 'Could not get download link. The video might be restricted or unavailable.',
        details: result.error || result.message || 'Unknown error'
      });
    }

    // Sanitize filename
    const safeTitle = sanitize(title).substring(0, 100) || 'audio';
    const filename = `${safeTitle}.mp3`;
    const tempPath = path.join(TEMP_DIR, `${Date.now()}-${Math.random().toString(36).substring(7)}.mp3`);

    console.log('Downloading from:', downloadUrl.substring(0, 100) + '...');

    // Step 2: Download the file
    await downloadFile(downloadUrl, tempPath);

    // Step 3: Send to client
    const stats = await fs.stat(tempPath);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Length', stats.size);

    const readStream = require('fs').createReadStream(tempPath);

    readStream.pipe(res);

    readStream.on('close', async () => {
      // Clean up temp file after download
      try {
        await fs.unlink(tempPath);
      } catch (e) {
        console.error('Cleanup error:', e.message);
      }
    });

    readStream.on('error', (err) => {
      console.error('Stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download failed' });
      }
    });

  } catch (error) {
    console.error('Conversion error:', error.message);
    res.status(500).json({
      error: 'Conversion failed. Please try again.',
      details: error.message
    });
  }
});

// Serve static frontend
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
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
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
    
    .login-form, .converter-form {
      display: none;
    }
    
    .login-form.active, .converter-form.active {
      display: block;
    }
    
    .form-group {
      margin-bottom: 20px;
    }
    
    label {
      display: block;
      font-size: 14px;
      font-weight: 500;
      color: #374151;
      margin-bottom: 8px;
    }
    
    input[type="text"], input[type="password"], select {
      width: 100%;
      padding: 14px 16px;
      border: 2px solid #e5e7eb;
      border-radius: 12px;
      font-size: 16px;
      transition: all 0.2s;
    }
    
    input:focus, select:focus {
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
    
    .video-meta p {
      font-size: 12px;
      color: #666;
    }
    
    .error {
      background: #fee2e2;
      color: #dc2626;
      padding: 12px 16px;
      border-radius: 8px;
      margin-bottom: 16px;
      font-size: 14px;
      display: none;
    }
    
    .error.show {
      display: block;
    }
    
    .success {
      background: #d1fae5;
      color: #059669;
      padding: 12px 16px;
      border-radius: 8px;
      margin-bottom: 16px;
      font-size: 14px;
      display: none;
    }
    
    .success.show {
      display: block;
    }
    
    .loading {
      display: none;
      text-align: center;
      padding: 20px;
    }
    
    .loading.show {
      display: block;
    }
    
    .spinner {
      width: 40px;
      height: 40px;
      border: 4px solid #e5e7eb;
      border-top-color: #667eea;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 12px;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
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
    
    <!-- Login Form -->
    <div class="login-form active" id="loginForm">
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" placeholder="Enter access password">
      </div>
      <button onclick="login()">Access Converter</button>
    </div>
    
    <!-- Converter Form -->
    <div class="converter-form" id="converterForm">
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
      
      <div class="form-group">
        <label for="quality">Audio Quality</label>
        <select id="quality">
          <option value="128">128 kbps (Standard)</option>
          <option value="192">192 kbps (High)</option>
          <option value="320">320 kbps (Best)</option>
        </select>
      </div>
      
      <div class="loading" id="loading">
        <div class="spinner"></div>
        <p>Converting... Please wait</p>
      </div>
      
      <button onclick="convert()" id="convertBtn">Convert to MP3</button>
      
      <div class="footer">
        <p>For personal use only</p>
      </div>
    </div>
  </div>
  
  <script>
    let sessionId = localStorage.getItem('sessionId');
    
    // Check if already logged in
    if (sessionId) {
      document.getElementById('loginForm').classList.remove('active');
      document.getElementById('converterForm').classList.add('active');
    }
    
    // Auto-fetch video info when URL changes
    let debounceTimer;
    document.getElementById('url').addEventListener('input', function() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(fetchVideoInfo, 500);
    });
    
    async function login() {
      const password = document.getElementById('password').value;
      const errorEl = document.getElementById('error');
      
      try {
        const res = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        
        const data = await res.json();
        
        if (data.success) {
          sessionId = data.sessionId;
          localStorage.setItem('sessionId', sessionId);
          document.getElementById('loginForm').classList.remove('active');
          document.getElementById('converterForm').classList.add('active');
          errorEl.classList.remove('show');
        } else {
          errorEl.textContent = data.error || 'Login failed';
          errorEl.classList.add('show');
        }
      } catch (err) {
        errorEl.textContent = 'Connection error. Please try again.';
        errorEl.classList.add('show');
      }
    }
    
    async function fetchVideoInfo() {
      const url = document.getElementById('url').value.trim();
      const videoInfoEl = document.getElementById('videoInfo');
      
      if (!url || !url.includes('youtube') && !url.includes('youtu.be')) {
        videoInfoEl.classList.remove('show');
        return;
      }
      
      try {
        const res = await fetch('/api/info?url=' + encodeURIComponent(url) + '&sessionId=' + sessionId);
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
      const quality = document.getElementById('quality').value;
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
        const downloadUrl = '/api/convert?url=' + encodeURIComponent(url) + '&quality=' + quality + '&sessionId=' + sessionId;
        
        const response = await fetch(downloadUrl);
        
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Conversion failed');
        }
        
        // Get filename from Content-Disposition or use default
        const disposition = response.headers.get('Content-Disposition');
        let filename = 'audio.mp3';
        if (disposition) {
          const match = disposition.match(/filename\\*?=['"]?(?:UTF-8'')?([^;'"]+)/i);
          if (match) {
            filename = decodeURIComponent(match[1]);
          }
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
    
    // Handle Enter key in password field
    document.getElementById('password').addEventListener('keypress', function(e) {
      if (e.key === 'Enter') login();
    });
    
    // Handle Enter key in URL field
    document.getElementById('url').addEventListener('keypress', function(e) {
      if (e.key === 'Enter') convert();
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
  console.log(\`Server running on port \${PORT}\`);
  console.log(\`Visit http://localhost:\${PORT} to use the converter\`);
});
