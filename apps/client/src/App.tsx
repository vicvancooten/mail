import { healthResponseSchema } from "@mail/shared";

// Scaffold placeholder. The real triage UI lives on the
// `prototype/triage-loop-ui` branch and lands here once that ticket's
// direction is merged in.
function App() {
  const shape = healthResponseSchema.shape;

  return (
    <main>
      <h1>Mail</h1>
      <p>Client scaffold is up. Wired to @mail/shared: {Object.keys(shape).join(", ")}.</p>
    </main>
  );
}

export default App;
