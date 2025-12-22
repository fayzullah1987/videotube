const API =
  window.location.hostname === 'localhost' ? 'http://localhost:3000' : window.location.origin;

function getVideoIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('v');
}

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
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

function seekToTime(seconds) {
  const video = document.getElementById('videoPlayer');
  video.currentTime = seconds;
  video.play();
}

async function loadVideo() {
  const videoId = getVideoIdFromUrl();

  if (!videoId) {
    document.getElementById('videoContainer').innerHTML =
      '<div class="error">Video not found</div>';
    return;
  }

  try {
    const res = await fetch(`${API}/api/videos/${videoId}`);
    const data = await res.json();

    if (!data.video) {
      throw new Error('Video not found');
    }

    const video = data.video;
    const streamUrl = `${API}/api/stream/${videoId}`;

    // Calculate time for each thumbnail
    const thumbnailTimes = video.thumbnails.map((_, index) => {
      return (index / (video.thumbnails.length - 1)) * video.duration;
    });

    document.getElementById('videoContainer').innerHTML = `
          <div class="player-wrapper">
            <video id="videoPlayer" controls autoplay>
              <source src="${streamUrl}" type="video/mp4">
              Your browser does not support the video tag.
            </video>
          </div>

          <div class="video-info">
            <h1 class="video-title">${video.title}</h1>
            
            <div class="video-metadata">
              <div class="video-stats">
                <span>${formatViews(video.views)} views</span>
                <span>${formatDate(video.created_at)}</span>
              </div>
            </div>

            ${
              video.description
                ? `
              <div class="video-description">
                <div class="description-header">Description</div>
                <div class="description-text">${video.description}</div>
              </div>
            `
                : ''
            }

            <div class="thumbnails-section">
              <div class="thumbnails-header">Video Timeline</div>
              <div class="thumbnails-grid">
                ${video.thumbnails
                  .map(
                    (thumb, index) => `
                  <div class="thumbnail-item" onclick="seekToTime(${thumbnailTimes[index].toFixed(
                    2
                  )})">
                    <img src="${API}${thumb}" alt="Thumbnail ${index + 1}">
                    <div class="thumbnail-time">${formatDuration(thumbnailTimes[index])}</div>
                  </div>
                `
                  )
                  .join('')}
              </div>
            </div>
          </div>
        `;

    // Update page title
    document.title = `${video.title} - VideoTube`;
  } catch (err) {
    console.error('Error loading video:', err);
    document.getElementById('videoContainer').innerHTML =
      '<div class="error">Failed to load video</div>';
  }
}

// Load video on page load
loadVideo();
