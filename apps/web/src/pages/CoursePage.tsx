import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { ClassSummary, CourseDetail, CourseVisualization, QuizSummary } from "@studdy/shared";
import { ApiError } from "../api/client";
import {
  useCourse,
  useCourseQuizzes,
  useCourseVisualizations,
  useCreateClass,
  useDeleteCourse,
  useUpdateCourse,
} from "../api/hooks";
import { Badge, StatusBadge } from "../components/Badge";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { Button } from "../components/Button";
import { ClassForm } from "../components/ClassForm";
import { ConfirmDialog, Dialog } from "../components/Dialog";
import { CourseForm } from "../components/CourseForm";
import { EmptyState } from "../components/EmptyState";
import { ErrorMessage } from "../components/ErrorMessage";
import { QueryBoundary } from "../components/QueryBoundary";
import { Spinner } from "../components/Spinner";
import {
  cadenceLabel,
  countMaterials,
  countNotes,
  countQuestions,
  formatClassNumber,
  formatDate,
} from "../lib/format";
import styles from "./CoursePage.module.css";

export function CoursePage() {
  const courseId = Number(useParams().courseId);
  const query = useCourse(courseId);
  return (
    <QueryBoundary query={query} backTo="/" backLabel="Nazad na kurseve">
      {(course) => <CourseView course={course} />}
    </QueryBoundary>
  );
}

function CourseView({ course }: { course: CourseDetail }) {
  const navigate = useNavigate();
  const updateCourse = useUpdateCourse(course.id);
  const deleteCourse = useDeleteCourse(course.id);
  const createClass = useCreateClass(course.id);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const nextNumber = course.classes.reduce((max, item) => Math.max(max, item.number), 0) + 1;

  return (
    <>
      <Breadcrumbs items={[{ label: "Kursevi", to: "/" }, { label: course.name }]} />

      <header className={styles.header}>
        <h1 className={styles.title}>{course.name}</h1>
        <div className={styles.actions}>
          <Link to={`/kursevi/${course.id}/napredak`} className={styles.progressLink}>
            Napredak
          </Link>
          <Button onClick={() => setEditing(true)}>Izmeni kurs</Button>
          <Button variant="danger" onClick={() => setDeleting(true)}>
            Obriši kurs
          </Button>
        </div>
      </header>

      {(course.persona || course.assessmentFormat || course.reviewCadence) && (
        <dl className={styles.details}>
          {course.persona && (
            <div>
              <dt>Uloga tutora</dt>
              <dd>{course.persona}</dd>
            </div>
          )}
          {course.assessmentFormat && (
            <div>
              <dt>Format ispita</dt>
              <dd>{course.assessmentFormat}</dd>
            </div>
          )}
          {course.reviewCadence && (
            <div>
              <dt>Kumulativni test</dt>
              <dd>{cadenceLabel(course.reviewCadence)}</dd>
            </div>
          )}
        </dl>
      )}

      <h2>Predavanja</h2>
      <ClassList classes={course.classes} />

      <h2 className={styles.sectionHeading}>Kvizovi</h2>
      <QuizList courseId={course.id} />

      <h2 className={styles.sectionHeading}>Vizualizacije</h2>
      <VisualizationList courseId={course.id} />

      <h2 className={styles.sectionHeading}>Dodaj predavanje</h2>
      <ClassForm
        inline
        resetOnSuccess
        submitLabel="Dodaj predavanje"
        suggestedNumber={nextNumber}
        onSubmit={(input) => createClass.mutateAsync(input)}
      />

      <Dialog open={editing} onClose={() => setEditing(false)} title="Izmeni kurs">
        <CourseForm
          initial={course}
          submitLabel="Sačuvaj"
          onCancel={() => setEditing(false)}
          onSubmit={async (input) => {
            await updateCourse.mutateAsync(input);
            setEditing(false);
          }}
        />
      </Dialog>

      <ConfirmDialog
        open={deleting}
        title="Obriši kurs"
        confirmLabel="Obriši kurs"
        pending={deleteCourse.isPending}
        error={
          deleteCourse.isError
            ? deleteCourse.error instanceof ApiError
              ? deleteCourse.error.message
              : "Brisanje nije uspelo."
            : null
        }
        onClose={() => {
          setDeleting(false);
          deleteCourse.reset();
        }}
        onConfirm={() => deleteCourse.mutate(undefined, { onSuccess: () => void navigate("/") })}
      >
        <p>
          Obrisati kurs <strong>{course.name}</strong>?
        </p>
        <p>Sva predavanja i materijali ovog kursa biće obrisani. Ovo se ne može poništiti.</p>
      </ConfirmDialog>
    </>
  );
}

function ClassList({ classes }: { classes: ClassSummary[] }) {
  if (classes.length === 0) return <EmptyState message="Još nema predavanja." />;

  return (
    <ul className={styles.classes}>
      {classes.map((item) => (
        <li key={item.id} className={styles.classItem}>
          <div className={styles.classMain}>
            <Link to={`/predavanja/${item.id}`} className={styles.classLink}>
              {formatClassNumber(item.number)} — {item.title}
            </Link>
            <span className={styles.counts}>
              {countMaterials(item.materialCount)} · {countNotes(item.noteCount)}
            </span>
          </div>
          <StatusBadge status={item.status} />
        </li>
      ))}
    </ul>
  );
}

function QuizList({ courseId }: { courseId: number }) {
  const query = useCourseQuizzes(courseId);
  if (query.isPending) return <Spinner />;
  if (query.isError) return <ErrorMessage>Kvizovi se nisu učitali.</ErrorMessage>;
  if (query.data.length === 0) {
    return (
      <EmptyState message="Još nema kvizova. Kviz se pravi automatski posle objedinjenih beleški." />
    );
  }

  return (
    <ul className={styles.classes}>
      {query.data.map((item) => (
        <QuizItem key={item.id} quiz={item} />
      ))}
    </ul>
  );
}

function QuizItem({ quiz }: { quiz: QuizSummary }) {
  return (
    <li className={styles.quizItem}>
      <Link to={`/kvizovi/${quiz.id}`} className={styles.quizHead}>
        <strong className={styles.quizCode}>{quiz.code}</strong>
        <span className={styles.quizTitle}>{quiz.title}</span>
      </Link>
      <p className={styles.counts}>{quiz.subtitle}</p>
      {quiz.chips.length > 0 && (
        <ul className={styles.chips} aria-label="Oznake">
          {quiz.chips.map((chip) => (
            <li key={chip}>
              <Badge>{chip}</Badge>
            </li>
          ))}
        </ul>
      )}
      <p className={styles.counts}>
        {countQuestions(quiz.questionCount)} · {formatDate(quiz.createdAt)}
      </p>
    </li>
  );
}

function VisualizationList({ courseId }: { courseId: number }) {
  const query = useCourseVisualizations(courseId);
  if (query.isPending) return <Spinner />;
  if (query.isError) return <ErrorMessage>Vizualizacije se nisu učitale.</ErrorMessage>;
  if (query.data.length === 0) {
    return (
      <EmptyState message="Još nema vizualizacija. Teme biraš na stranici predavanja, posle objedinjenih beleški." />
    );
  }
  return (
    <ul className={styles.classes}>
      {query.data.map((item) => (
        <VisualizationItem key={item.id} viz={item} />
      ))}
    </ul>
  );
}

function VisualizationItem({ viz }: { viz: CourseVisualization }) {
  return (
    <li className={styles.classItem}>
      <div className={styles.classMain}>
        <Link to={`/vizualizacije/${viz.id}`} className={styles.classLink}>
          {viz.title}
        </Link>
        <span className={styles.counts}>
          {formatClassNumber(viz.classNumber)} — {viz.className}
        </span>
      </div>
    </li>
  );
}
