/** Mobile composers keep Enter for newlines; desktop retains Enter to send. */
export function shouldSendOnEnter(event: KeyboardEvent): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    !window.matchMedia("(pointer: coarse)").matches
  );
}
