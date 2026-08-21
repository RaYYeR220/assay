import type { NextConfig } from 'next';

/**
 * The dashboard ships as a fully static bundle so it can be served from GitHub Pages.
 * Everything it displays is either baked in at build time (deployment addresses, recorded
 * rounds) or read straight from a public RPC in the browser. There is no server runtime and
 * no secret of any kind in this build.
 *
 * `NEXT_PUBLIC_BASE_PATH` should be set to `/<repo>` when publishing to a project page.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  basePath,
  images: { unoptimized: true },
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default nextConfig;
