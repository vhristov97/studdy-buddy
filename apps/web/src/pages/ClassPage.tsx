import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { ClassDetail, MaterialSummary } from "@studdy/shared";
import { ApiError } from "../api/client";
import {
  useClass,
  useDeleteClass,
  useDeleteMaterial,
  useGenerate,
  useUpdateClass,
} from "../api/hooks";
import { StatusBadge } from "../components/Badge";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { Button } from "../components/Button";
import { ClassForm } from "../components/ClassForm";
import { ConfirmDialog, Dialog } from "../components/Dialog";
import { EmptyState } from "../components/EmptyState";
import { ErrorMessage } from "../components/ErrorMessage";
import { MaterialItem } from "../components/MaterialItem";
import { PipelinePanel } from "../components/PipelinePanel";
import { QueryBoundary } from "../components/QueryBoundary";
import { UploadZone } from "../components/UploadZone";
import { canGenerate } from "../lib/canGenerate";
import { formatClassNumber } from "../lib/format";
import styles from "./ClassPage.module.css";

export function ClassPage() {
  const classId = Number(useParams().classId);
  const query = useClass(classId);
  return (
    <QueryBoundary query={query} backTo="/" backLabel="Nazad na kurseve">
      {(detail) => <ClassView detail={detail} />}
    </QueryBoundary>
  );
}

function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : "Brisanje nije uspelo.";
}

function generateErrorText(error: unknown): string {
  return error instanceof ApiError ? error.message : "Generisanje nije uspelo.";
}

function ClassView({ detail }: { detail: ClassDetail }) {
  const navigate = useNavigate();
  const updateClass = useUpdateClass(detail.id);
  const deleteClass = useDeleteClass(detail.id, detail.courseId);
  const deleteMaterial = useDeleteMaterial(detail.id);
  const generate = useGenerate(detail.id);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [materialToDelete, setMaterialToDelete] = useState<MaterialSummary | null>(null);

  const editable = detail.status === "draft";
  const materials = detail.materials.filter((item) => item.kind === "material");
  const notes = detail.materials.filter((item) => item.kind === "note");
  const readiness = canGenerate(detail);
  const label = `${formatClassNumber(detail.number)} — ${detail.title}`;

  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Kursevi", to: "/" },
          { label: detail.courseName, to: `/kursevi/${detail.courseId}` },
          { label },
        ]}
      />

      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{label}</h1>
          <StatusBadge status={detail.status} />
        </div>
        <div className={styles.actions}>
          <Button onClick={() => setEditing(true)}>Izmeni</Button>
          <Button variant="danger" onClick={() => setDeleting(true)}>
            Obriši predavanje
          </Button>
        </div>
      </header>

      {editable ? (
        <UploadZone classId={detail.id} />
      ) : (
        <p className={styles.locked}>Materijali se ne mogu menjati nakon generisanja.</p>
      )}

      <section aria-labelledby="materials-heading" className={styles.section}>
        <h2 id="materials-heading">Materijali</h2>
        {materials.length === 0 ? (
          <EmptyState message="Još nema materijala. Potreban je bar jedan PDF ili HTML fajl." />
        ) : (
          <ul className={styles.list}>
            {materials.map((item) => (
              <MaterialItem
                key={item.id}
                item={item}
                onDelete={editable ? setMaterialToDelete : undefined}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="notes-heading" className={styles.section}>
        <h2 id="notes-heading">Beleške</h2>
        <p className={styles.hint}>Beleške nisu obavezne, ali poboljšavaju objedinjene beleške.</p>
        {notes.length > 0 && (
          <ul className={styles.list}>
            {notes.map((item) => (
              <MaterialItem
                key={item.id}
                item={item}
                onDelete={editable ? setMaterialToDelete : undefined}
              />
            ))}
          </ul>
        )}
      </section>

      <section className={styles.generate} aria-label="Generisanje">
        <PipelinePanel
          key={detail.id}
          classId={detail.id}
          courseId={detail.courseId}
          classStatus={detail.status}
        />
        {detail.status === "ready" ? (
          <Link to={`/predavanja/${detail.id}/lekcija`} className={styles.lessonLink}>
            Otvori objedinjene beleške
          </Link>
        ) : (
          <>
            {(detail.status === "draft" || detail.status === "failed") && (
              <Button
                variant="primary"
                disabled={!readiness.ok || generate.isPending}
                onClick={() => generate.mutate()}
              >
                {generate.isPending
                  ? "Generiše se…"
                  : detail.status === "failed"
                    ? "Pokušaj ponovo"
                    : "Generiši"}
              </Button>
            )}
            {!readiness.ok && <p className={styles.reason}>{readiness.reason}</p>}
          </>
        )}
        {generate.isError && <ErrorMessage>{generateErrorText(generate.error)}</ErrorMessage>}
      </section>

      <Dialog open={editing} onClose={() => setEditing(false)} title="Izmeni predavanje">
        <ClassForm
          initial={{ title: detail.title, number: detail.number }}
          submitLabel="Sačuvaj"
          onCancel={() => setEditing(false)}
          onSubmit={async (input) => {
            await updateClass.mutateAsync(input);
            setEditing(false);
          }}
        />
      </Dialog>

      <ConfirmDialog
        open={deleting}
        title="Obriši predavanje"
        confirmLabel="Obriši predavanje"
        pending={deleteClass.isPending}
        error={deleteClass.isError ? errorText(deleteClass.error) : null}
        onClose={() => {
          setDeleting(false);
          deleteClass.reset();
        }}
        onConfirm={() =>
          deleteClass.mutate(undefined, {
            onSuccess: () => void navigate(`/kursevi/${detail.courseId}`),
          })
        }
      >
        <p>
          Obrisati predavanje <strong>{label}</strong>?
        </p>
        <p>Svi materijali i beleške ovog predavanja biće obrisani.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={materialToDelete !== null}
        title="Obriši fajl"
        confirmLabel="Obriši"
        pending={deleteMaterial.isPending}
        error={deleteMaterial.isError ? errorText(deleteMaterial.error) : null}
        onClose={() => {
          setMaterialToDelete(null);
          deleteMaterial.reset();
        }}
        onConfirm={() => {
          if (!materialToDelete) return;
          deleteMaterial.mutate(materialToDelete.id, {
            onSuccess: () => setMaterialToDelete(null),
          });
        }}
      >
        <p>
          Obrisati fajl <strong>{materialToDelete?.originalName}</strong>?
        </p>
      </ConfirmDialog>
    </>
  );
}
