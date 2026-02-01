# YouTube to MP3 Converter (Render Deployment)

A secure, password-protected YouTube to MP3 converter designed for deployment on Render.com with mobile-first design.

## ✨ Features

- 🔒 **Password Protected** - Secure access with login
- 📱 **Mobile Optimized** - Perfect for phones and tablets
- 🚀 **Cloud Deployed** - Access from anywhere via Render.com
- 🛡️ **Rate Limited** - 20 conversions per hour
- 🧹 **Auto Cleanup** - Temporary files removed automatically
- 🎵 **High Quality** - 192 kbps MP3 output
- 🔐 **Session Management** - Stay logged in for 24 hours
- 📊 **No Tracking** - No logging of downloads

## 🚀 Quick Start

### For Deployment

See **[DEPLOY_TO_RENDER.md](DEPLOY_TO_RENDER.md)** for complete step-by-step deployment instructions.

**Quick version:**
1. Upload code to GitHub (private repository)
2. Create Render.com account
3. Connect your GitHub repo to Render
4. Set environment variables (PASSWORD, SESSION_SECRET)
5. Deploy!

### For Users

1. Open the app URL on your phone
2. Login with the password
3. Paste a YouTube link
4. Tap "Convert to MP3"
5. Wait 30-60 seconds
6. Download starts automatically

## 🔑 Environment Variables

Set these in your Render.com dashboard:

```env
ACCESS_PASSWORD=your_secure_password_here
SESSION_SECRET=generate_a_random_32+_character_string
NODE_ENV=production
PORT=10000
```

## 📱 Mobile Features

- ✅ Responsive design (works on all screen sizes)
- ✅ Large touch targets (44px minimum for accessibility)
- ✅ Prevents iOS zoom on input focus
- ✅ Add to home screen support
- ✅ Works in portrait and landscape
- ✅ Optimized for slow connections

## 🛡️ Security

- Password authentication required
- Session-based access (24-hour sessions)
- Rate limiting (20 conversions/hour)
- Input validation (YouTube URLs only)
- Helmet.js security headers
- No logging of download content
- Automatic file cleanup

## 📁 Project Structure

```
youtube-mp3-render/
├── server.js              - Main Node.js server
├── package.json           - Dependencies
├── render.yaml            - Render configuration
├── .env.example           - Environment variables template
├── .gitignore             - Git ignore rules
├── public/
│   ├── index.html         - Web interface
│   └── styles.css         - Mobile-optimized CSS
├── DEPLOY_TO_RENDER.md    - Deployment guide
└── README.md              - This file
```

## 💰 Cost

### Render Free Tier
- 750 hours/month free
- Spins down after 15 minutes of inactivity
- Good for occasional use

### Render Starter ($7/month)
- No spin down (always fast)
- Better for daily use
- 512 MB RAM

## ⚖️ Legal Notice

**FOR PERSONAL USE ONLY**

- Only download content you have rights to
- Respect copyright laws and creators' rights
- Comply with YouTube's Terms of Service
- Do not share this tool publicly
- Do not use for commercial purposes

## 🔧 Troubleshooting

### Build Fails on Render
- Check all files are uploaded to GitHub
- Verify `package.json` syntax
- Check Render build logs

### Can't Login
- Verify `ACCESS_PASSWORD` is set correctly in Render
- Check for typos or extra spaces
- Password is case-sensitive

### Conversion Fails
- Some videos are restricted or protected
- Live streams are not supported
- Age-restricted content may fail
- Check rate limit (20/hour)

### App is Slow
- Free tier spins down after 15 minutes
- First request after spin down takes 30-60 seconds
- Upgrade to paid tier for better performance

## 🔄 Updating

To update your deployed app:

1. Edit files on GitHub
2. Commit changes
3. Render auto-deploys (if enabled)
4. Or manually deploy from Render dashboard

## 📊 Monitoring

View usage in Render dashboard:
- Click on your service
- Check "Logs" tab for activity
- View "Metrics" for performance stats

## 🆘 Support

1. Read DEPLOY_TO_RENDER.md
2. Check Render logs for errors
3. Verify environment variables
4. Test with different videos

## 🙏 Credits

Built with:
- Node.js & Express
- yt-dlp (YouTube downloader)
- FFmpeg (audio conversion)
- bcrypt (password hashing)
- Various security packages

## 📝 License

For personal use only. Not for distribution.

---

**Remember:** Use responsibly, respect copyright, support creators! 🎵
