import { Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { ClassPage } from "./pages/ClassPage";
import { CoursePage } from "./pages/CoursePage";
import { CoursesPage } from "./pages/CoursesPage";
import { MaterialPage } from "./pages/MaterialPage";
import { NotFoundPage } from "./pages/NotFoundPage";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<CoursesPage />} />
        <Route path="kursevi/:courseId" element={<CoursePage />} />
        <Route path="predavanja/:classId" element={<ClassPage />} />
        <Route path="materijali/:materialId" element={<MaterialPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
