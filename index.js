require('dotenv').config();
const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const Minio = require('minio');
const cors = require('cors');
const { Readable } = require('stream');

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

// MinIO Client
const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: parseInt(process.env.MINIO_PORT) || 9000,
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'admin',
  secretKey: process.env.MINIO_SECRET_KEY || 'password123'
});

const BUCKET_NAME = process.env.MINIO_BUCKET || 'videotube';

// Ensure bucket exists
async function ensureBucket() {
  try {
    const exists = await minioClient.bucketExists(BUCKET_NAME);
    if (!exists) {
      await minioClient.makeBucket(BUCKET_NAME, 'us-east-1');
      console.log(`✅ Created bucket: ${BUCKET_NAME}`);

      // Set public read policy
      const policy = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${BUCKET_NAME}/*`]
          }
        ]
      };
      await minioClient.setBucketPolicy(BUCKET_NAME, JSON.stringify(policy));
    }
  } catch (err) {
    console.error('Bucket setup error:', err);
  }
}

ensureBucket();

// Multer for temporary file storage
const upload = multer({
  dest: 'uploads/videos',
  limits: { fileSize: 500 * 1024 * 1024 }
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

// Upload file to MinIO
async function uploadToMinio(filePath, objectName, contentType) {
  const fileStream = fs.createReadStream(filePath);
  const stats = fs.statSync(filePath);

  await minioClient.putObject(BUCKET_NAME, objectName, fileStream, stats.size, {
    'Content-Type': contentType
  });
}

// Get MinIO URL
function getMinioUrl(objectName) {
  const endpoint = process.env.MINIO_ENDPOINT || 'localhost';
  const port = process.env.MINIO_PORT || 9000;
  const useSSL = process.env.MINIO_USE_SSL === 'true';
  const protocol = useSSL ? 'https' : 'http';

  // For production, use public URL if available
  if (process.env.MINIO_PUBLIC_URL) {
    return `${process.env.MINIO_PUBLIC_URL}/${BUCKET_NAME}/${objectName}`;
  }

  return `${protocol}://${endpoint}:${port}/${BUCKET_NAME}/${objectName}`;
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
    await generateThumbnails(tempVideoPath, tempThumbnailDir, 10);

    // Upload video to MinIO
    console.log('⬆️  Uploading video to MinIO...');
    await uploadToMinio(tempVideoPath, `videos/${videoId}.mp4`, 'video/mp4');

    // Upload thumbnails to MinIO
    console.log('⬆️  Uploading thumbnails to MinIO...');
    const thumbnailFiles = fs
      .readdirSync(tempThumbnailDir)
      .filter((f) => f.endsWith('.jpg'))
      .sort();

    for (const thumbFile of thumbnailFiles) {
      const thumbPath = path.join(tempThumbnailDir, thumbFile);
      await uploadToMinio(thumbPath, `thumbnails/${videoId}/${thumbFile}`, 'image/jpeg');
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
        getMinioUrl(`thumbnails/${video.videoId}/thumb_${i + 1}.jpg`)
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
      getMinioUrl(`thumbnails/${video.videoId}/thumb_${i + 1}.jpg`)
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

// Stream video from MinIO
app.get('/api/stream/:videoId', async (req, res) => {
  try {
    const video = await Video.findOne({ videoId: req.params.videoId });

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const objectName = `videos/${video.videoId}.mp4`;

    // Get object stats for file size
    const stat = await minioClient.statObject(BUCKET_NAME, objectName);
    const fileSize = stat.size;

    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = end - start + 1;

      // Stream partial content from MinIO
      const dataStream = await minioClient.getObject(BUCKET_NAME, objectName);

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4'
      });

      // Skip to start position and limit to end
      let bytesRead = 0;
      dataStream.on('data', (chunk) => {
        if (bytesRead >= start && bytesRead < end) {
          res.write(chunk);
        }
        bytesRead += chunk.length;
        if (bytesRead >= end) {
          dataStream.destroy();
          res.end();
        }
      });

      dataStream.on('end', () => res.end());
      dataStream.on('error', (err) => {
        console.error('Stream error:', err);
        res.status(500).end();
      });
    } else {
      // Stream full video
      const dataStream = await minioClient.getObject(BUCKET_NAME, objectName);

      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4'
      });

      dataStream.pipe(res);
    }
  } catch (err) {
    console.error('Stream error:', err);
    res.status(500).json({ error: 'Stream failed' });
  }
});

// Health check
app.get('/health', async (req, res) => {
  try {
    const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    const minioBuckets = await minioClient.listBuckets();

    res.json({
      status: 'healthy',
      mongodb: mongoStatus,
      minio: minioBuckets.length > 0 ? 'connected' : 'disconnected',
      bucket: BUCKET_NAME
    });
  } catch (err) {
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📊 MongoDB: ${MONGODB_URI}`);
  console.log(`📦 MinIO: ${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT}`);
  console.log(`🪣 Bucket: ${BUCKET_NAME}`);
});
