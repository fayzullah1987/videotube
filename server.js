require('dotenv').config();
const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const cors = require('cors');

// Set FFmpeg paths
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Create temp directories
['uploads/videos', 'thumbnails'].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/videotube';
mongoose
  .connect(MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch((err) => console.error('❌ MongoDB error:', err));

// Video Schema
const videoSchema = new mongoose.Schema({
  videoId: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  filename: { type: String, required: true },
  duration: { type: Number, required: true },
  thumbnailCount: { type: Number, default: 0 },
  views: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const Video = mongoose.model('Video', videoSchema);

// Cloudflare R2 Client (S3-compatible)
const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT, // https://xxxxx.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

const BUCKET_NAME = process.env.R2_BUCKET || 'videotube';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL; // https://pub-xxxxx.r2.dev

// Multer for temporary file storage
const upload = multer({
  dest: 'uploads/videos',
  limits: {
    fileSize: 5 * 1024 * 1024 * 1024 // 5GB limit
  }
});

// Get video metadata
function getVideoMetadata(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata);
    });
  });
}

// Generate thumbnails
function generateThumbnails(videoPath, outputDir, count = 10) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    ffmpeg(videoPath)
      .screenshots({
        count: count,
        folder: outputDir,
        filename: 'thumb_%i.jpg',
        size: '320x180'
      })
      .on('end', () => resolve())
      .on('error', reject);
  });
}

// Upload file to R2 with multipart support for large files
async function uploadToR2(filePath, key, contentType) {
  const fileStats = fs.statSync(filePath);
  const fileSize = fileStats.size;

  // For files under 100MB, use simple upload
  if (fileSize < 100 * 1024 * 1024) {
    const fileContent = fs.readFileSync(filePath);
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: fileContent,
      ContentType: contentType
    });
    await r2Client.send(command);
    return;
  }

  // For larger files, use multipart upload
  const { Upload } = require('@aws-sdk/lib-storage');
  const fileStream = fs.createReadStream(filePath);

  const upload = new Upload({
    client: r2Client,
    params: {
      Bucket: BUCKET_NAME,
      Key: key,
      Body: fileStream,
      ContentType: contentType
    },
    // Upload in 100MB chunks
    partSize: 100 * 1024 * 1024,
    queueSize: 4 // Upload 4 parts concurrently
  });

  upload.on('httpUploadProgress', (progress) => {
    const percent = Math.round((progress.loaded / progress.total) * 100);
    console.log(`   Uploading ${key}: ${percent}%`);
  });

  await upload.done();
  console.log(`   ✅ ${key} uploaded successfully`);
}

// Get R2 URL (public or signed)
function getR2Url(key) {
  // If you have R2 public URL configured, use it
  if (R2_PUBLIC_URL) {
    return `${R2_PUBLIC_URL}/${key}`;
  }

  // Otherwise, we'll generate signed URLs on-demand
  return `/api/media/${encodeURIComponent(key)}`;
}

// Generate signed URL for private R2 objects
async function getSignedR2Url(key, expiresIn = 3600) {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key
  });

  return await getSignedUrl(r2Client, command, { expiresIn });
}

// Upload video endpoint
app.post('/api/upload', upload.single('video'), async (req, res) => {
  let tempVideoPath = null;
  let tempThumbnailDir = null;

  try {
    const videoFile = req.file;
    const { title, description } = req.body;

    if (!videoFile || !title) {
      return res.status(400).json({ error: 'Video and title required' });
    }

    tempVideoPath = videoFile.path;
    const videoId = path.parse(videoFile.filename).name;
    tempThumbnailDir = path.join('thumbnails', videoId);

    console.log(`📹 Processing video: ${title}`);

    // Get video duration
    const metadata = await getVideoMetadata(tempVideoPath);
    const duration = metadata.format.duration;

    // Generate thumbnails
    console.log('🎬 Generating thumbnails...');
    await generateThumbnails(tempVideoPath, tempThumbnailDir, 10);

    // Upload video to R2
    console.log('☁️  Uploading video to Cloudflare R2...');
    await uploadToR2(tempVideoPath, `videos/${videoId}.mp4`, 'video/mp4');

    // Upload thumbnails to R2
    console.log('🖼️  Uploading thumbnails to R2...');
    const thumbnailFiles = fs
      .readdirSync(tempThumbnailDir)
      .filter((f) => f.endsWith('.jpg'))
      .sort();

    for (const thumbFile of thumbnailFiles) {
      const thumbPath = path.join(tempThumbnailDir, thumbFile);
      await uploadToR2(thumbPath, `thumbnails/${videoId}/${thumbFile}`, 'image/jpeg');
    }

    // Save to MongoDB
    const video = new Video({
      videoId,
      title,
      description: description || '',
      filename: `${videoId}.mp4`,
      duration,
      thumbnailCount: thumbnailFiles.length
    });

    await video.save();

    // Cleanup temp files
    fs.unlinkSync(tempVideoPath);
    fs.rmSync(tempThumbnailDir, { recursive: true, force: true });

    console.log('✅ Upload complete!');

    res.json({
      success: true,
      video: {
        id: video._id,
        videoId: video.videoId,
        title: video.title,
        duration: video.duration
      }
    });
  } catch (err) {
    console.error('Upload error:', err);

    // Cleanup on error
    if (tempVideoPath && fs.existsSync(tempVideoPath)) {
      fs.unlinkSync(tempVideoPath);
    }
    if (tempThumbnailDir && fs.existsSync(tempThumbnailDir)) {
      fs.rmSync(tempThumbnailDir, { recursive: true, force: true });
    }

    res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

// Get all videos
app.get('/api/videos', async (req, res) => {
  try {
    const videos = await Video.find().sort({ createdAt: -1 }).select('-__v');

    const videosWithThumbnails = videos.map((video) => ({
      ...video.toObject(),
      thumbnails: Array.from({ length: video.thumbnailCount }, (_, i) =>
        getR2Url(`thumbnails/${video.videoId}/thumb_${i + 1}.jpg`)
      )
    }));

    res.json({ videos: videosWithThumbnails });
  } catch (err) {
    console.error('Error fetching videos:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get single video
app.get('/api/videos/:videoId', async (req, res) => {
  try {
    const video = await Video.findOne({ videoId: req.params.videoId });

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Increment views
    video.views += 1;
    await video.save();

    const thumbnails = Array.from({ length: video.thumbnailCount }, (_, i) =>
      getR2Url(`thumbnails/${video.videoId}/thumb_${i + 1}.jpg`)
    );

    res.json({
      video: {
        ...video.toObject(),
        thumbnails
      }
    });
  } catch (err) {
    console.error('Error fetching video:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Serve media from R2 (for private buckets without public URL)
app.get('/api/media/:key(*)', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);

    // Generate signed URL and redirect
    const signedUrl = await getSignedR2Url(key, 3600);
    res.redirect(signedUrl);
  } catch (err) {
    console.error('Media fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch media' });
  }
});

// Stream video from R2
app.get('/api/stream/:videoId', async (req, res) => {
  try {
    const video = await Video.findOne({ videoId: req.params.videoId });

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const key = `videos/${video.videoId}.mp4`;

    // For R2, we'll use signed URLs which support range requests
    const signedUrl = await getSignedR2Url(key, 3600);

    // Redirect to signed URL (R2 handles range requests)
    res.redirect(signedUrl);
  } catch (err) {
    console.error('Stream error:', err);
    res.status(500).json({ error: 'Stream failed' });
  }
});

// Health check
app.get('/health', async (req, res) => {
  try {
    const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';

    res.json({
      status: 'healthy',
      mongodb: mongoStatus,
      r2: 'configured',
      bucket: BUCKET_NAME,
      publicUrl: R2_PUBLIC_URL || 'using signed URLs'
    });
  } catch (err) {
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📊 MongoDB: ${MONGODB_URI}`);
  console.log(`☁️  Cloudflare R2 Bucket: ${BUCKET_NAME}`);
  console.log(`🌐 Public URL: ${R2_PUBLIC_URL || 'Using signed URLs'}`);
});
