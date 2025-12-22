// Auto-detect API URL (works locally and on Render)
const API =
  window.location.hostname === 'localhost' ? 'http://localhost:3000' : window.location.origin;

let currentThumbnailIntervals = {};

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatViews(views) {
  if (views >= 1000000) return `${(views / 1000000).toFixed(1)}M`;
  if (views >= 1000) return `${(views / 1000).toFixed(1)}K`;
  return views;
}

function formatDate(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now - date;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

function startThumbnailPreview(videoId, thumbnails) {
  if (!thumbnails || thumbnails.length === 0) return;

  let currentIndex = 0;
  const img = document.querySelector(`[data-video-id="${videoId}"]`);

  currentThumbnailIntervals[videoId] = setInterval(() => {
    currentIndex = (currentIndex + 1) % thumbnails.length;
    img.src = thumbnails[currentIndex];
  }, 800);
}

function stopThumbnailPreview(videoId, firstThumbnail) {
  if (currentThumbnailIntervals[videoId]) {
    clearInterval(currentThumbnailIntervals[videoId]);
    delete currentThumbnailIntervals[videoId];
  }

  const img = document.querySelector(`[data-video-id="${videoId}"]`);
  if (img && firstThumbnail) {
    img.src = firstThumbnail;
  }
}

async function loadVideos() {
  try {
    const res = await fetch(`${API}/api/videos`);
    const data = await res.json();

    const grid = document.getElementById('videoGrid');

    if (data.videos.length === 0) {
      grid.innerHTML = '<div class="no-videos">No videos yet. Upload one to get started!</div>';
      return;
    }

    grid.innerHTML = data.videos
      .map(
        (video) => `
          <div class="video-card" 
               onclick="openVideo('${video.videoId}')"
               onmouseenter="startThumbnailPreview('${video.videoId}', ${JSON.stringify(
          video.thumbnails
        ).replace(/"/g, '&quot;')})"
               onmouseleave="stopThumbnailPreview('${video.videoId}', '${video.thumbnails[0]}')">
            <div class="thumbnail-container">
              <img src="${video.thumbnails[0]}" 
                   alt="${video.title}" 
                   class="thumbnail"
                   data-video-id="${video.videoId}">
              <div class="duration">${formatDuration(video.duration)}</div>
            </div>
            <div class="video-info">
              <div class="video-title">${video.title}</div>
              <div class="video-meta">
                ${formatViews(video.views)} views • ${formatDate(video.createdAt)}
              </div>
            </div>
          </div>
        `
      )
      .join('');
  } catch (err) {
    console.error('Error loading videos:', err);
    document.getElementById('videoGrid').innerHTML =
      '<div class="no-videos">Error loading videos</div>';
  }
}

function openVideo(videoId) {
  window.location.href = `/watch.html?v=${videoId}`;
}

function openUploadModal() {
  document.getElementById('uploadModal').classList.add('active');
}

function closeUploadModal() {
  document.getElementById('uploadModal').classList.remove('active');
  document.getElementById('uploadForm').reset();
  document.getElementById('progressBar').style.display = 'none';
}

document.getElementById('uploadForm').onsubmit = async (e) => {
  e.preventDefault();

  const fileInput = document.getElementById('videoFile');
  const title = document.getElementById('videoTitle').value;
  const description = document.getElementById('videoDescription').value;

  if (!fileInput.files[0]) return;

  const formData = new FormData();
  formData.append('video', fileInput.files[0]);
  formData.append('title', title);
  formData.append('description', description);

  const progressBar = document.getElementById('progressBar');
  const progressBarFill = document.getElementById('progressBarFill');
  progressBar.style.display = 'block';

  try {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percentComplete = (e.loaded / e.total) * 100;
        progressBarFill.style.width = percentComplete + '%';
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status === 200) {
        closeUploadModal();
        loadVideos();
      } else {
        alert('Upload failed');
      }
    });

    xhr.open('POST', `${API}/api/upload`);
    xhr.send(formData);
  } catch (err) {
    console.error('Upload error:', err);
    alert('Upload failed');
  }
};

// Load videos on page load
loadVideos();
