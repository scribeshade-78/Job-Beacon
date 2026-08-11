import { APP_NAME } from "../../shared/app";

export function App() {
  return (
    <main className="app-shell">
      <section aria-labelledby="app-title" className="foundation-card">
        <p className="eyebrow">Local foundation</p>
        <h1 id="app-title">{APP_NAME}</h1>
        <p>The client foundation is running.</p>
      </section>
    </main>
  );
}

