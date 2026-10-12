// Значок поверх игры: меняет состояние плавно и приглушается, когда ничего не происходит
const TEXT = { seeing: "видит игру", "no-image": "нет картинки", "waiting-dota": "ждёт Доту", off: "выключен" };
const CALM_AFTER_MS = 6e3;
const badge = document.getElementById("badge");
const status = document.getElementById("status");
let current = null;
let calmTimer = null;
function setState(s) {
  if (s.state === current) return;
  const first = current === null;
  current = s.state;
  badge.className = `badge ${s.state}${first ? " enter" : ""}`;
  status.classList.add("swap");
  setTimeout(() => {
    status.textContent = TEXT[s.state] ?? "";
    status.classList.remove("swap");
  }, 180);
  clearTimeout(calmTimer);
  // Спокойное состояние «видит игру» — приглушаем, чтобы не отвлекать; проблемы остаются яркими
  if (s.state === "seeing") calmTimer = setTimeout(() => badge.classList.add("calm"), CALM_AFTER_MS);
}
badge.addEventListener("animationend", (e) => {
  if (e.animationName === "enter") badge.classList.remove("enter");
});
window.dotacoachOverlay?.onState(setState);
