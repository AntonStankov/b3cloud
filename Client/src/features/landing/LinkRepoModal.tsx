import { useEffect, useState } from "react";
import Modal from "../../components/Modal";
import Icon from "../../components/Icon";
import { isValidRepoUrl, listRepos, type GithubRepo } from "../../api/mocks/github";
import { startTrialSession } from "../../api/mocks/auth";
import styles from "./LinkRepoModal.module.css";

interface LinkRepoModalProps {
  open: boolean;
  onClose: () => void;
  onLinked: (projectId: string, githubUrl: string) => void;
}

function projectIdFromUrl(githubUrl: string): string {
  const slug = githubUrl
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .slice(-1)[0]
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  return `${slug || "app"}-${Math.random().toString(36).slice(2, 6)}`;
}

export default function LinkRepoModal({ open, onClose, onLinked }: LinkRepoModalProps) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoadingRepos(true);
    listRepos()
      .then(setRepos)
      .finally(() => setLoadingRepos(false));
  }, [open]);

  const link = (githubUrl: string) => {
    if (!isValidRepoUrl(githubUrl)) {
      setError("Enter a valid GitHub repository URL.");
      return;
    }
    // A future GitHub App flow would replace this. For now we open a trial session.
    startTrialSession();
    onLinked(projectIdFromUrl(githubUrl), githubUrl.trim());
  };

  return (
    <Modal open={open} title="Link a GitHub repository" onClose={onClose}>
      <p className="muted" style={{ marginBottom: 16 }}>
        We&apos;ll analyze the repo and lay out your infrastructure in the builder.
      </p>

      <form
        className={styles.urlForm}
        onSubmit={(event) => {
          event.preventDefault();
          link(url);
        }}
      >
        <label className="field" style={{ flex: 1 }}>
          <span>Repository URL</span>
          <input
            className="input"
            placeholder="https://github.com/org/repo"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setError(null);
            }}
            autoFocus
          />
        </label>
        <button type="submit" className="btn btn-accent">
          Continue
        </button>
      </form>
      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.divider}>
        <span>or pick a connected repo</span>
      </div>

      <div className={styles.repoList}>
        {loadingRepos && <p className="muted">Loading repositories…</p>}
        {!loadingRepos &&
          repos.map((repo) => (
            <button
              key={repo.id}
              className={styles.repoRow}
              onClick={() => link(repo.html_url)}
            >
              <span className={styles.repoIcon}>
                <Icon name="github" size={18} />
              </span>
              <span className={styles.repoMeta}>
                <strong>
                  {repo.full_name}
                  {repo.private && <span className="badge">private</span>}
                </strong>
                <small className="muted">{repo.description}</small>
              </span>
              <span className={styles.repoLang}>{repo.language}</span>
            </button>
          ))}
      </div>
    </Modal>
  );
}
