import { Link } from "react-router";

export function NotFoundPage() {
  return (
    <section>
      <h1>Stranica ne postoji</h1>
      <p>
        <Link to="/">Nazad na početnu</Link>
      </p>
    </section>
  );
}
