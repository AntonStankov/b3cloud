import { useEffect, useState } from "react";
import Modal from "../../components/Modal";
import Icon from "../../components/Icon";
import { validateApiKey } from "../../api/client";
import { getApiKey, setApiKey, USE_MOCKS } from "../../api/config";
import { isValidRepoUrl, listRepos, type GithubRepo } from "../../api/mocks/github";
import { startTrialSession } from "../../api/mocks/auth";
import styles from "./LinkRepoModal.module.css";

interface LinkRepoModalProps {
  open: boolean;
  onClose: () => void;
  onLinked: (projectId: string, githubUrl: string) => void;
  onApiKeySaved?: () => void;
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

export default function LinkRepoModal({
  open,
  onClose,
  onLinked,
  onApiKeySaved,
}: LinkRepoModalProps) {
  const [url, setUrl] = useState("");
  const [apiKey, setApiKeyValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    if (!open) return;
    setApiKeyValue(getApiKey());
    setError(null);
    if (!USE_MOCKS) {
      setRepos([]);
      setLoadingRepos(false);
      return;
    }
    setLoadingRepos(true);
    listRepos()
      .then(setRepos)
      .finally(() => setLoadingRepos(false));
  }, [open]);

  const link = async (githubUrl: string) => {
    if (!isValidRepoUrl(githubUrl)) {
      setError("Enter a valid GitHub repository URL.");
      return;
    }
    const key = apiKey.trim();
    if (!key) {
      setError("Paste the b3cloud user API key before testing a real deploy.");
      return;
    }

    setLinking(true);
    setError(null);
    try {
      await validateApiKey(key);
      setApiKey(key);
      onApiKeySaved?.();
      // A future GitHub App flow would replace this. For now we open a trial session.
      startTrialSession();
      onLinked(projectIdFromUrl(githubUrl), githubUrl.trim());
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setLinking(false);
    }
  };

  return (
    <Modal open={open} title="Link a GitHub repository" onClose={onClose}>
      <p className="muted" style={{ marginBottom: 16 }}>
        We&apos;ll analyze the repo and lay out your infrastructure in the builder.
      </p>

      <label className={`field ${styles.apiKeyField}`}>
        <span>User API key</span>
        <input
          className="input mono"
          type="password"
          placeholder="Required for the live b3cloud API"
          value={apiKey}
          onChange={(event) => {
            setApiKeyValue(event.target.value);
            setError(null);
          }}
        />
      </label>

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
        <button type="submit" className="btn btn-accent" disabled={linking}>
          {linking && <Icon name="spinner" size={16} />}
          {linking ? "Testing..." : "Continue"}
        </button>
      </form>
      {error && <p className={styles.error}>{error}</p>}

      {USE_MOCKS && (
        <>
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
                  disabled={linking}
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
        </>
      )}
    </Modal>
  );
}
