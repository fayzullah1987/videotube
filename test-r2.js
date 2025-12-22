require('dotenv').config();
const { S3Client, PutObjectCommand, ListBucketsCommand } = require('@aws-sdk/client-s3');

const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

async function testR2() {
  try {
    console.log('🧪 Testing Cloudflare R2...');

    // Test 1: List buckets
    const { Buckets } = await r2Client.send(new ListBucketsCommand({}));
    console.log(
      '✅ Connected! Buckets:',
      Buckets.map((b) => b.Name)
    );

    // Test 2: Upload test file
    const testData = Buffer.from('Hello from VideoTube!');
    await r2Client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: 'test.txt',
        Body: testData,
        ContentType: 'text/plain'
      })
    );

    console.log('✅ Upload successful!');
    console.log(`✅ File URL: ${process.env.R2_PUBLIC_URL}/test.txt`);
    console.log('\n🎉 R2 is working! Open the URL above in your browser.');
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error('Full error:', err);
  }
}

testR2();
