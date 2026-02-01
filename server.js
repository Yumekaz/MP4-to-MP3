require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const validator = require('validator');
const YTDlpWrap = require('yt-dlp-wrap').default;
const ffmpeg = require('fluent-ffmpeg');
const sanitize = require('sanitize-filename');

const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');
const MAX_FILE_AGE_MS = 30 * 60 * 1000; // 30 minutes

// Set ffmpeg path - use environment variable or auto-detect
// On Render (Linux), ffmpeg is installed via apt and available in PATH
// On Windows, we use the explicit path from winget installation
if (process.platform === 'win32') {
  const ffmpegPath = process.env.FFMPEG_PATH || 'C:\\Users\\Mihir\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.0.1-full_build\\bin\\ffmpeg.exe';
  ffmpeg.setFfmpegPath(ffmpegPath);
}



// ============================================
// SECURITY MIDDLEWARE
// ============================================

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
    }
  }
}));

app.use(express.json({ limit: '1kb' }));
app.use(express.urlencoded({ extended: true, limit: '1kb' }));



// Rate limiting: 20 requests per hour per IP (more generous for cloud)
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/convert', limiter);



// ============================================
// UTILITY FUNCTIONS
// ============================================

function isValidYouTubeUrl(url) {
  if (!validator.isURL(url, {
    protocols: ['http', 'https'],
    require_protocol: true
  })) {
    return false;
  }

  const allowedDomains = [
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'youtu.be'
  ];

  try {
    const urlObj = new URL(url);
    return allowedDomains.includes(urlObj.hostname);
  } catch {
    return false;
  }
}

async function ensureTempDir() {
  try {
    await fs.access(TEMP_DIR);
  } catch {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  }
}

async function cleanupOldFiles() {
  try {
    const files = await fs.readdir(TEMP_DIR);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      try {
        const stats = await fs.stat(filePath);

        if (now - stats.mtimeMs > MAX_FILE_AGE_MS) {
          await fs.unlink(filePath);
          console.log(`Cleaned up old file: ${file}`);
        }
      } catch (err) {
        continue;
      }
    }
  } catch (error) {
    console.error('Cleanup error:', error.message);
  }
}

// ============================================
// API ENDPOINTS
// ============================================



// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main conversion endpoint
app.post('/api/convert', async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({
      error: 'Invalid YouTube URL. Only YouTube links are supported.'
    });
  }

  let tempVideoPath = null;
  let tempAudioPath = null;

  try {
    await ensureTempDir();

    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(7);
    const baseFilename = `${timestamp}-${randomId}`;

    tempVideoPath = path.join(TEMP_DIR, `${baseFilename}.webm`);
    tempAudioPath = path.join(TEMP_DIR, `${baseFilename}.mp3`);

    console.log(`Downloading audio from: ${url}`);

    // Initialize yt-dlp wrapper
    const ytDlpWrap = new YTDlpWrap();

    // Download best audio
    await ytDlpWrap.execPromise([
      url,
      '-o', tempVideoPath,
      '-f', 'bestaudio',
      '--no-playlist',
      '--restrict-filenames',
      '--no-warnings'
    ]);

    // Get video info
    const infoOutput = await ytDlpWrap.execPromise([
      url,
      '--dump-single-json',
      '--no-warnings'
    ]);

    const info = JSON.parse(infoOutput);
    const safeTitle = sanitize(info.title || 'audio').substring(0, 100);

    console.log('Converting to MP3...');

    await new Promise((resolve, reject) => {
      ffmpeg(tempVideoPath)
        .toFormat('mp3')
        .audioBitrate('192k')
        .audioChannels(2)
        .on('error', reject)
        .on('end', resolve)
        .save(tempAudioPath);
    });

    res.download(tempAudioPath, `${safeTitle}.mp3`, async (err) => {
      try {
        if (tempVideoPath) await fs.unlink(tempVideoPath).catch(() => { });
        if (tempAudioPath) await fs.unlink(tempAudioPath).catch(() => { });
      } catch (cleanupError) {
        console.error('Cleanup error:', cleanupError.message);
      }

      if (err && !res.headersSent) {
        console.error('Download error:', err.message);
        res.status(500).json({ error: 'Download failed' });
      }
    });

  } catch (error) {
    console.error('Conversion error:', error.message);

    try {
      if (tempVideoPath) await fs.unlink(tempVideoPath).catch(() => { });
      if (tempAudioPath) await fs.unlink(tempAudioPath).catch(() => { });
    } catch { }

    if (!res.headersSent) {
      res.status(500).json({
        error: 'Conversion failed. Please check the URL and try again.'
      });
    }
  }
});

// ============================================
// STATIC FILE SERVING
// ============================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// STARTUP
// ============================================

async function startServer() {
  await ensureTempDir();

  setInterval(cleanupOldFiles, 15 * 60 * 1000);
  await cleanupOldFiles();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════════╗
║  YouTube to MP3 Converter                     ║
║  Running on port: ${PORT}                      ║
║                                               ║
║  ⚠️  FOR PERSONAL USE ONLY                    ║
╚═══════════════════════════════════════════════╝
    `);
  });
}

startServer().catch(console.error);

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await cleanupOldFiles();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  await cleanupOldFiles();
  process.exit(0);
});
