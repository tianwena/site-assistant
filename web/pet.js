/* =========================================================================
   pet.js —— 桌宠状态机（静态头像 + CSS 动效）
   素材：assets/pet/avatar.webp（睁眼）与 avatar-blink.webp（闭眼），取自
         _archive/pet-masters/01-idle.webm 同一段眨眼的两帧，已对齐，各约 10KB。
   为什么不再用视频：五段视频在 52px 里缩小约 10 倍，细节变毛边；段与段之间
         硬切，动作接不上。现在动作全部由 CSS 过渡完成，状态之间是连续的。
   状态（挂在 [data-pet] 上的 class，样式见 base.css「桌宠」一节）：
     待机   无 class，呼吸 + 随机眨眼
     思考   is-thinking —— chat.js 在生成回复时调 __pet.think()，结束调 rest()
     被点   is-poked    —— 点击 / 回车 / 空格，弹一下并眨眼
     睡觉   is-sleeping —— 面板开着但 45 秒没有互动；任何互动都会叫醒
   面板收起或页面切到后台时，眨眼与睡眠计时都停掉（CSS 动画本身随面板隐藏不渲染）。
   ========================================================================= */
(function () {
  "use strict";

  var stack = document.querySelector("[data-pet]");
  if (!stack) return;

  var assistant = document.querySelector("[data-assistant]");
  var SLEEP_AFTER = 45000;
  var state = "idle";
  var blinkTimer = null;
  var sleepTimer = null;
  var pokeTimer = null;

  function visible() { return !document.hidden && (!assistant || assistant.open); }

  function set(name) {
    state = name;
    stack.classList.toggle("is-thinking", name === "think");
    stack.classList.toggle("is-sleeping", name === "sleep");
  }

  /* 眨眼：闭眼图盖上 120ms 再撤掉；睡觉时闭眼图常驻，不另外眨 */
  function blink() {
    if (state === "sleep") return;
    stack.classList.add("is-blink");
    setTimeout(function () { stack.classList.remove("is-blink"); }, 120);
  }
  function scheduleBlink() {
    clearTimeout(blinkTimer);
    if (!visible()) return;
    blinkTimer = setTimeout(function () { blink(); scheduleBlink(); }, 2600 + Math.random() * 3400);
  }

  /* 任何互动都把睡眠计时归零；思考中不会入睡 */
  function touch() {
    clearTimeout(sleepTimer);
    if (state === "sleep") set("idle");
    if (!visible()) return;
    sleepTimer = setTimeout(function () { if (state === "idle") set("sleep"); }, SLEEP_AFTER);
  }

  function poke() {
    touch();
    stack.classList.remove("is-poked");
    void stack.offsetWidth;                 // 重启动画：连点时每次都弹
    stack.classList.add("is-poked");
    blink();
    clearTimeout(pokeTimer);
    pokeTimer = setTimeout(function () { stack.classList.remove("is-poked"); }, 450);
  }

  stack.addEventListener("click", poke);    // <button> 的回车 / 空格也会触发 click

  function wake() {
    if (visible()) { scheduleBlink(); touch(); }
    else { clearTimeout(blinkTimer); clearTimeout(sleepTimer); }
  }
  document.addEventListener("visibilitychange", wake);
  if (assistant) assistant.addEventListener("toggle", wake);
  wake();

  window.__pet = {
    think: function () { touch(); set("think"); },
    rest: function () { if (state === "think") set("idle"); touch(); },
    poke: poke,
    current: function () { return state; }
  };
})();
