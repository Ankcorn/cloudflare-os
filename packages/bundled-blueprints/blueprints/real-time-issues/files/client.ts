// Loading the Gadget UI activates its persistent local-webhook callback. Gadget server objects are
// otherwise lazy, so constructor-only setup would not run merely because the workspace was created.
declare const gadget: {install(): Promise<void>};

const status = document.createElement("p");
status.style.cssText = "font: 14px system-ui; padding: 16px; color: #555";
status.textContent = "Connecting local webhook…";
document.body.append(status);

try {
  await gadget.install();
  status.textContent = "Local webhook connected. Ready for POST /gatekeeper/webhook/trigger.";
} catch (error) {
  status.textContent = `Local webhook setup failed: ${error instanceof Error ? error.message : String(error)}`;
  throw error;
}
