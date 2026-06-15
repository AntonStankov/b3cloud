import { useEffect, useState } from "react";
import { validateApiKey } from "../api/client";
import { clearApiKey, getApiKey, setApiKey } from "../api/config";
import Modal from "./Modal";
import Icon from "./Icon";
import styles from "./ApiKeyModal.module.css";

interface ApiKeyModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

export default function ApiKeyModal({ open, onClose, onSaved }: ApiKeyModalProps) {
  const [value, setValue] = useState("");
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<"idle" | "ok" | "error">("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!open) return;
    setValue(getApiKey());
    setStatus("idle");
    setMessage("");
  }, [open]);

  const save = async () => {
    const key = value.trim();
    if (!key) {
      setStatus("error");
      setMessage("Paste the b3cloud user API key first.");
      return;
    }

    setTesting(true);
    setStatus("idle");
    setMessage("");
    try {
      await validateApiKey(key);
      setApiKey(key);
      setStatus("ok");
      setMessage("Connected to the live b3cloud user API.");
      onSaved?.();
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  };

  const forget = () => {
    clearApiKey();
    setValue("");
    setStatus("idle");
    setMessage("");
    onSaved?.();
  };

  return (
    <Modal open={open} title="Connect to b3cloud API" onClose={onClose}>
      <p className={`muted ${styles.copy}`}>
        The live API requires the tenant user API key. It is stored only in this
        browser&apos;s localStorage and sent as <span className="mono">X-Api-Key</span>.
      </p>

      <div className={styles.form}>
        <label className="field">
          <span>User API key</span>
          <input
            className="input mono"
            type="password"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setStatus("idle");
              setMessage("");
            }}
            placeholder="Paste B3_USER_API_KEY"
            autoFocus
          />
        </label>

        {message && (
          <p
            className={`${styles.status} ${
              status === "ok" ? styles.ok : styles.error
            }`}
          >
            {message}
          </p>
        )}

        <div className={styles.actions}>
          <button className="btn btn-ghost btn-sm" type="button" onClick={forget}>
            Forget key
          </button>
          <button
            className="btn btn-accent"
            type="button"
            disabled={testing}
            onClick={save}
          >
            {testing && <Icon name="spinner" size={16} />}
            {testing ? "Testing..." : "Test and save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
