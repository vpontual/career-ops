/** @type {import('next').NextConfig} */
const nextConfig = {
  // Full static outputs aren't usable — we read files at request time.
  output: "standalone",
  // Don't cache pages — we want fresh data each request since the file mtime
  // changes every time the scanner runs.
  experimental: {
    staleTimes: { dynamic: 0, static: 0 }
  }
};

export default nextConfig;
