import { useEffect, useState } from "react";
import { renderSVG } from "uqr";
import {
  beginTotp,
  confirmTotp,
  disableTotp,
  passkeyStepUp,
  setStepUpPrompt,
  signInWithTotp,
  totpStepUp,
} from "./api";
import { Icon } from "./icons";

export function SetupQr({ value }: { value: string }) {
  return <div className="qr" aria-label="Authenticator QR code" dangerouslySetInnerHTML={{ __html: renderSVG(value) }} />;
}

export function TotpSignIn({ onDone, onNote }: { onDone: () => void; onNote: (note: string) => void }) {
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      signInWithTotp(code, backup).then(onDone).catch((err: unknown) => onNote(err instanceof Error ? err.message : "Could not sign in."));
    }}>
      <p>Or sign in with an authenticator code.</p>
      <label>{backup ? "Backup code" : "Authenticator code"}
        <input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" inputMode={backup ? "text" : "numeric"} />
      </label>
      <button className="pill" type="submit"><Icon name="shield" size={20} /> Sign in with code</button>
      <div className="row">
        <button className="linkish" type="button" onClick={() => { setBackup(!backup); setCode(""); }}>{backup ? "Use an authenticator code" : "Use a backup code"}</button>
      </div>
    </form>
  );
}

export function AuthenticatorSettings({ enabled, onError, onRefresh }: { enabled: boolean; onError: (message: string) => void; onRefresh: () => Promise<void> }) {
  const [setup, setSetup] = useState<{ otpauthUri: string; setupKey: string } | null>(null);
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  async function start() {
    onError("");
    try {
      setSetup(await beginTotp());
      setBackupCodes(null);
      setCode("");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not start authenticator setup.");
    }
  }
  async function confirm() {
    onError("");
    try {
      const next = await confirmTotp(code);
      setBackupCodes(next.backupCodes);
      setSetup(null);
      setCode("");
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not confirm the authenticator.");
    }
  }
  async function turnOff() {
    onError("");
    try {
      await disableTotp();
      setSetup(null);
      setBackupCodes(null);
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not turn off the authenticator.");
    }
  }
  return (
    <>
      <h3>Authenticator app</h3>
      {backupCodes && (
        <div>
          <p>Save these backup codes. Each can be used once. They will not be shown again.</p>
          <pre className="backup-codes">{backupCodes.join("\n")}</pre>
          <button type="button" onClick={() => setBackupCodes(null)}>I saved these codes</button>
        </div>
      )}
      {setup && !backupCodes && (
        <div>
          <p>Scan this QR code with your authenticator app, or enter the setup key.</p>
          <SetupQr value={setup.otpauthUri} />
          <label>Setup key<input value={setup.setupKey} readOnly /></label>
          <label>Code from the app<input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" inputMode="numeric" /></label>
          <div className="row">
            <button type="button" onClick={() => void confirm()}>Confirm</button>
            <button className="quiet" type="button" onClick={() => setSetup(null)}>Cancel</button>
          </div>
        </div>
      )}
      {!setup && !backupCodes && !enabled && (
        <>
          <p>Use an authenticator app to sign in when a passkey is not available, for example on a remote desktop.</p>
          <button type="button" onClick={() => void start()}>Set up authenticator app</button>
        </>
      )}
      {!setup && !backupCodes && enabled && (
        <>
          <p>An authenticator app is set up. You can sign in or confirm with a code from the app, or with a backup code.</p>
          <div className="row">
            <button className="quiet" type="button" onClick={() => void turnOff()}>Turn off authenticator app</button>
            <button type="button" onClick={() => void start()}>Set up again</button>
          </div>
        </>
      )}
    </>
  );
}

export function StepUpHost({ totpEnabled }: { totpEnabled: boolean }) {
  const [open, setOpen] = useState<{ required: "passkey" | "any"; resolve: (ok: boolean) => void } | null>(null);
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    setStepUpPrompt((required) => new Promise((resolve) => {
      setCode("");
      setBackup(false);
      setNote("");
      setOpen({ required, resolve });
    }));
    return () => setStepUpPrompt(() => passkeyStepUp());
  }, []);
  function finish(ok: boolean) {
    open?.resolve(ok);
    setOpen(null);
  }
  if (!open) return null;
  const allowTotp = totpEnabled && open.required === "any";
  return (
    <div className="stepup-mask">
      <div className="card stepup" role="dialog" aria-label="Confirm">
        <p>Confirm with your passkey.</p>
        <div className="row">
          <button type="button" onClick={() => void passkeyStepUp().then((ok) => { if (ok) finish(true); else setNote("Passkey confirmation failed."); })}><Icon name="key" /> Use passkey</button>
          <button className="quiet" type="button" onClick={() => finish(false)}>Cancel</button>
        </div>
        {allowTotp && (
          <form onSubmit={(event) => {
            event.preventDefault();
            totpStepUp(code, backup).then(() => finish(true)).catch((err: unknown) => setNote(err instanceof Error ? err.message : "That code is not valid."));
          }}>
            <p>Or enter an authenticator code.</p>
            <label>{backup ? "Backup code" : "Authenticator code"}
              <input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" />
            </label>
            <div className="row">
              <button type="submit">Confirm with code</button>
              <button className="quiet" type="button" onClick={() => { setBackup(!backup); setCode(""); }}>{backup ? "Use an authenticator code" : "Use a backup code"}</button>
            </div>
          </form>
        )}
        {note && <p className="error">{note}</p>}
      </div>
    </div>
  );
}
