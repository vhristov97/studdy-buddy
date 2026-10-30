import { Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { CoursesPage } from "./pages/CoursesPage";
import { NotFoundPage } from "./pages/NotFoundPage";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<CoursesPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
