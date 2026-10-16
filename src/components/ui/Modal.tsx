import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { prefersReducedMotion } from './motion';
import './Modal.css';

export interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 見出し（`aria-labelledby` の参照先にもなる）。 */
  readonly title: string;
  /** `dialog` は中央のカード、`drawer` は右から出る全高のパネル（ハンバーガーメニュー）。 */
  readonly variant?: 'dialog' | 'drawer';
  readonly children: ReactNode;
  /** カード下部の操作（確認ダイアログのボタンなど）。 */
  readonly footer?: ReactNode;
  readonly testId?: string;
  /** 見出しの上に添える小さな札（MENU など）。 */
  readonly eyebrow?: string;
}

/** 退場アニメーションの長さ。CSS の `--modal-exit` と合わせる。 */
const EXIT_MS = 200;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * モーダル（ダイアログ / ドロワー）。
 *
 * - `role="dialog"` + `aria-modal`。開いているあいだ Tab は中に閉じ込め、Esc と背景のタップで閉じる。
 * - 閉じたら、開く前にフォーカスしていた要素へ戻す。
 * - 開いているあいだは背面のスクロールを止める。
 * - 退場は 200ms のアニメーションを待ってから外す（動きを減らす設定では即座に外す）。
 *
 * 表示専用の部品で、アプリの状態は親が `open` / `onClose` で持つ。
 */
export function Modal({
  open,
  onClose,
  title,
  variant = 'dialog',
  children,
  footer,
  testId,
  eyebrow,
}: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);

  // 開閉の切り替えはレンダー中に調整する（effect で setState しない）。
  if (open && (!mounted || closing)) {
    setMounted(true);
    setClosing(false);
  } else if (!open && mounted && !closing) {
    // 動きを減らす設定では、退場を待たずにその場で外す。
    if (prefersReducedMotion()) setMounted(false);
    else setClosing(true);
  }

  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(
      () => {
        setMounted(false);
        setClosing(false);
      },
      EXIT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [closing]);

  // 開いた瞬間: フォーカスを中へ移し、背面のスクロールを止める。閉じたら元へ戻す。
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>('[data-autofocus]') ?? panel;
    first?.focus({ preventScroll: true });

    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      // 閉じる操作で別の画面へ移った場合も、元の要素がまだあればそこへ戻す。
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);

  if (!mounted) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (panel === null) return;
    const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (item) => item.offsetParent !== null || item === document.activeElement,
    );
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className={`modal modal--${variant}`}
      data-state={closing ? 'closing' : 'open'}
      onKeyDown={onKeyDown}
    >
      <div className="modal__backdrop" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        className="modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
      >
        <header className="modal__header">
          <div className="modal__titles">
            {eyebrow && <span className="modal__eyebrow">{eyebrow}</span>}
            <h2 id={titleId} className="modal__title">
              {title}
            </h2>
          </div>
          <button
            type="button"
            className="modal__close"
            aria-label="閉じる"
            data-testid={testId ? `${testId}-close` : undefined}
            onClick={onClose}
          >
            <span aria-hidden="true" />
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  /** 取り消せない操作は赤系で示す。 */
  readonly tone?: 'danger' | 'default';
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly testId?: string;
}

/**
 * 取り消せない操作の前に一度だけ確かめるダイアログ。
 *
 * 既定のフォーカスは「キャンセル」側に置く（Enter の連打で消さない）。
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'キャンセル',
  tone = 'default',
  onConfirm,
  onCancel,
  testId,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      testId={testId}
      footer={
        <>
          <button
            type="button"
            className="modal__button"
            data-autofocus
            data-testid={testId ? `${testId}-cancel` : undefined}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`modal__button modal__button--primary${tone === 'danger' ? ' modal__button--danger' : ''}`}
            data-testid={testId ? `${testId}-confirm` : undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
