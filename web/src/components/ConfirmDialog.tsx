import { useState } from "react";
import { Modal, ModalActions } from "./Modal";

/**
 * Confirmation dialog with async support. Renders a trigger via render-prop
 * and awaits the user's choice.
 *
 * Typical usage:
 *   <ConfirmButton className="danger" message="Delete user?" onConfirm={async () => api.deleteUser(id)}>
 *     Delete
 *   </ConfirmButton>
 */
export function ConfirmButton({
  children,
  message,
  confirmLabel = "Confirm",
  onConfirm,
  className,
  disabled,
  onSuccess,
}: {
  children: React.ReactNode;
  message: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
  className?: string;
  disabled?: boolean;
  onSuccess?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setOpen(false);
      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className={className} disabled={disabled} onClick={() => setOpen(true)}>
        {children}
      </button>
      {open && (
        <Modal title="Please confirm" onClose={busy ? () => {} : () => setOpen(false)}>
          <p style={{ marginTop: 0 }}>{message}</p>
          {error && <div className="error-banner">{error}</div>}
          <ModalActions>
            <button disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className={className ?? "primary"} disabled={busy} onClick={handleConfirm}>
              {busy ? "…" : confirmLabel}
            </button>
          </ModalActions>
        </Modal>
      )}
    </>
  );
}
