/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep Prisma's native engine and pino out of the bundler so route handlers trace them correctly.
  serverExternalPackages: ["@prisma/client", "pino"],
  reactStrictMode: true,
};

export default nextConfig;
