/**
 * Landing page for the Zone 3 web UI. Intentionally minimal — the application UI is built out
 * here; all backend calls go to the Fastify financial gateway (Zone 2), never to a Next.js API
 * route (there are none).
 */
export default function HomePage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "4rem auto", padding: "0 1rem" }}>
      <h1>QueenRoyal</h1>
      <p>
        Player web UI. This Next.js app serves the interface only — authentication, the cashier,
        and all financial operations are handled by the standalone gateway service.
      </p>
    </main>
  );
}
