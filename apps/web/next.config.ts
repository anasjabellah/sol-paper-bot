import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Optional override so a verification build never overwrites the output a running server uses.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Pin the monorepo root so stray lockfiles in parent folders are not picked up.
  outputFileTracingRoot: path.join(__dirname, '..', '..'),
  poweredByHeader: false,
  // The shared workspace package ships TypeScript source.
  transpilePackages: ['@spb/shared'],
  // Linting runs from the repo root (`npm run lint`).
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
