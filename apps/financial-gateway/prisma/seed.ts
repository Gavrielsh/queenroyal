import { PrismaClient } from "@prisma/client";

import { STORE_PACKAGES } from "../src/config/store-packages";

/**
 * Seed the store-package catalog (owned by the gateway, the sole writer of financial config).
 * Idempotent: re-running upserts the same rows.
 */
const prisma = new PrismaClient();

async function main(): Promise<void> {
  for (const pkg of STORE_PACKAGES) {
    await prisma.storePackage.upsert({
      where: { id: pkg.id },
      update: {
        label: pkg.label,
        priceUsdCents: pkg.priceUsdCents,
        gc: pkg.gc,
        sc: pkg.sc,
        active: true,
      },
      create: {
        id: pkg.id,
        label: pkg.label,
        priceUsdCents: pkg.priceUsdCents,
        gc: pkg.gc,
        sc: pkg.sc,
      },
    });
  }
  console.log(`Seeded ${STORE_PACKAGES.length} store packages.`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
