// dsh-notify-cues — browser half.
//
// A real settings page, not a bespoke popup: it registers a section into the
// official Settings dialog through `settings.section`, and renders its rows
// through a child slot it declares itself. Every control persists through the
// host's /dsh-notify-cues/config route, so nothing here needs a code change.
//
// Bundle format: a /plugins/<id>/client.js must self-register through
// window.__ModuleLoader__.load({ id, factory }). The factory receives the
// client module system's `require`, and the returned exports carry `apply` and
// `inject`.
window.__ModuleLoader__.load({
  id: "dsh-notify-cues",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    (() => {
      var __require = typeof require !== "undefined"
        ? require
        : (x) => { throw new Error('require("' + x + '") unavailable'); };
      var React = __require("react");
      var h = React.createElement;
      var useEffect = React.useEffect;
      var useState = React.useState;

      var CONFIG_URL = "/dsh-notify-cues/config";
      var PRESENCE_URL = "/dsh-notify-cues/presence";
      var TEST_URL = "/dsh-notify-cues/test";

      // ---------------------------------------------------------------------
      // Presence reporting.
      //
      // The host decides "quiet while watching" from live browser state, so the
      // client must tell it (a) whether the page is visible, (b) whether the DSH
      // window has focus, and (c) which session the main view is showing. (b)
      // and (c) matter: with only a page-level flag, a completion in ANOTHER
      // conversation would be silenced even though the user is reading this one.
      // ---------------------------------------------------------------------
      var lastSent = "";
      function reportPresence(patch) {
        var next = {
          visible: document.visibilityState === "visible",
          focused: document.hasFocus(),
        };
        if (patch && "viewedSessionId" in patch) next.viewedSessionId = patch.viewedSessionId;
        var key = JSON.stringify(next);
        if (key === lastSent) return;
        lastSent = key;
        try {
          fetch(PRESENCE_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: key,
            keepalive: true,
          }).catch(function () {});
        } catch (e) { /* presence is best effort */ }
      }

      // A session-scoped slot receives `sessionId` and `useSessions`. The main
      // view is the session whose `retainedBy.mainView` count is positive — the
      // same signal the layout uses to pick the window title.
      function PresenceReporter(props) {
        var sessionId = props && props.sessionId;
        var useSessions = props && props.useSessions;
        var current = useSessions
          ? useSessions(function (state) {
              var found = Object.keys(state.byId).find(function (id) {
                return (state.byId[id].retainedBy && state.byId[id].retainedBy.mainView) > 0;
              });
              return found === undefined ? null : found;
            })
          : null;

        useEffect(function () {
          var report = function () { reportPresence({ viewedSessionId: current || undefined }); };
          report();
          var onVisibility = function () { report(); };
          window.addEventListener("focus", onVisibility);
          window.addEventListener("blur", onVisibility);
          document.addEventListener("visibilitychange", onVisibility);
          // A short interval covers main-view switches, which fire no event on
          // window or document. It also re-asserts the session so a dropped POST
          // cannot leave the host thinking a stale session is being viewed.
          var timer = setInterval(report, 1500);
          return function () {
            window.removeEventListener("focus", onVisibility);
            window.removeEventListener("blur", onVisibility);
            document.removeEventListener("visibilitychange", onVisibility);
            clearInterval(timer);
            // Leaving this session means no session is being viewed.
            reportPresence({ viewedSessionId: undefined });
          };
        }, [current, sessionId]);

        // Reporting is the whole job: render nothing.
        return null;
      }

      // Scene metadata: order, label, and the sound this scene defaults to.
      var SCENES = [
        { key: "completed", zh: "任务完成", en: "Task complete", hintZh: "这一轮正常跑完", hintEn: "The turn finished normally" },
        { key: "interrupted", zh: "被中断", en: "Interrupted", hintZh: "你点了停止 / 按了 Esc", hintEn: "You pressed stop or Esc" },
        { key: "error", zh: "出错", en: "Error", hintZh: "这一轮因报错结束", hintEn: "The turn failed" },
        { key: "max-tokens", zh: "达到输出上限", en: "Output limit", hintZh: "模型用完了最大输出长度", hintEn: "The model hit its output ceiling" },
        { key: "blocked", zh: "被阻止", en: "Blocked", hintZh: "被拦截或依赖被取消", hintEn: "Blocked, or its dependency was cancelled" },
        { key: "attention", zh: "需要你操作", en: "Input needed", hintZh: "提问或审批在等你", hintEn: "A question or approval is waiting" },
      ];

      var SOUNDS = [
        { id: "completed", zh: "完成（上行双音）", en: "Complete (rising pair)" },
        { id: "interrupted", zh: "中断（下行短音）", en: "Interrupted (falling)" },
        { id: "error", zh: "出错（低沉不谐和）", en: "Error (low, dissonant)" },
        { id: "maxTokens", zh: "上限（三声急促）", en: "Limit (three pips)" },
        { id: "blocked", zh: "阻止（平音双击）", en: "Blocked (flat double)" },
        { id: "attention", zh: "提醒（三音上行）", en: "Attention (arpeggio)" },
        { id: "ding", zh: "叮咚（明亮点缀）", en: "Ding (bright)" },
        { id: "none", zh: "静音", en: "Silent" },
      ];

      var CSS = [
        '.dsnc-wrap{display:flex;flex-direction:column;gap:18px;padding:2px 0 12px}',
        '.dsnc-hd{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
        '.dsnc-hd h3{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e9f0)}',
        '.dsnc-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b93a7)}',
        '.dsnc-dot{align-self:center;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary,#4d6bfe)}',
        '.dsnc-card{border:1px solid var(--dsw-alias-border-l2,rgba(128,140,170,.22));border-radius:10px;padding:4px 14px}',
        '.dsnc-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 0;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(128,140,170,.14))}',
        '.dsnc-row:last-child{border-bottom:none}',
        '.dsnc-row-main{display:flex;flex-direction:column;gap:3px;min-width:0}',
        '.dsnc-name{font-size:13px;color:var(--dsw-alias-label-primary,#e6e9f0)}',
        '.dsnc-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b93a7)}',
        '.dsnc-sec{font-size:11.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8b93a7);padding:14px 0 6px}',
        '.dsnc-sw{position:relative;flex:none;width:38px;height:21px;border-radius:11px;border:none;padding:0;cursor:pointer;background:var(--dsw-alias-bg-layer-2,rgba(128,140,170,.3));transition:background .15s ease}',
        '.dsnc-sw[data-on="1"]{background:var(--dsw-alias-brand-primary,#4d6bfe)}',
        '.dsnc-sw i{position:absolute;top:2.5px;left:2.5px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.3)}',
        '.dsnc-sw[data-on="1"] i{transform:translateX(17px)}',
        '.dsnc-sw:disabled{opacity:.45;cursor:not-allowed}',
        '.dsnc-sel{flex:none;min-width:172px;height:30px;padding:0 8px;border-radius:8px;font-size:12.5px;cursor:pointer;color:var(--dsw-alias-label-primary,#e6e9f0);background:var(--dsw-alias-bg-layer-2,rgba(128,140,170,.18));border:1px solid var(--dsw-alias-border-l2,rgba(128,140,170,.24))}',
        '.dsnc-sel:disabled{opacity:.45;cursor:not-allowed}',
        '.dsnc-side{display:flex;align-items:center;gap:8px;flex:none}',
        '.dsnc-play{flex:none;width:30px;height:30px;border-radius:8px;cursor:pointer;font-size:12px;background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(128,140,170,.28));color:var(--dsw-alias-label-primary,#e6e9f0)}',
        '.dsnc-play:hover{background:var(--dsw-alias-hover-l2,rgba(128,140,170,.18))}',
        '.dsnc-play:disabled{opacity:.4;cursor:not-allowed}',
        '.dsnc-vol{display:flex;align-items:center;gap:10px;min-width:220px}',
        '.dsnc-vol input[type=range]{flex:1;min-width:120px;accent-color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:pointer}',
        '.dsnc-val{width:38px;text-align:right;font-size:11.5px;color:var(--dsw-alias-label-secondary,#9aa3b2)}',
        '.dsnc-note{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b93a7);line-height:1.65}',
        '.dsnc-err{font-size:12px;color:#e5534b;padding:8px 0}',
        '.dsnc-btn{height:30px;padding:0 12px;border-radius:8px;font-size:12.5px;cursor:pointer;background:var(--dsw-alias-brand-primary,#4d6bfe);border:none;color:#fff}',
        '.dsnc-btn.ghost{background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(128,140,170,.3));color:var(--dsw-alias-label-primary,#e6e9f0)}',
      ].join("");

      function isZh() {
        var lang = (document.documentElement.lang || navigator.language || "").toLowerCase();
        return lang.indexOf("zh") === 0;
      }

      function label(node) { return isZh() ? node.zh : node.en; }
      function hint(node) { return isZh() ? node.hintZh : node.hintEn; }

      function Toggle(props) {
        return h("button", {
          className: "dsnc-sw",
          "data-on": props.on ? "1" : "0",
          disabled: props.disabled ? true : undefined,
          title: props.on ? "on" : "off",
          onClick: function () { if (!props.disabled) props.onChange(!props.on); },
        }, h("i", null));
      }

      function Row(props) {
        return h("div", { className: "dsnc-row" }, [
          h("div", { className: "dsnc-row-main", key: "m" }, [
            h("span", { className: "dsnc-name", key: "n" }, props.name),
            props.hint ? h("span", { className: "dsnc-hint", key: "h" }, props.hint) : null,
          ]),
          h("div", { className: "dsnc-side", key: "s" }, props.children),
        ]);
      }

      function CuesPanel() {
        var cfgState = useState(null);
        var cfg = cfgState[0], setCfg = cfgState[1];
        var errState = useState("");
        var err = errState[0], setErr = errState[1];
        var busyState = useState("");
        var busy = busyState[0], setBusy = busyState[1];

        useEffect(function () {
          var style = document.createElement("style");
          style.textContent = CSS;
          document.head.appendChild(style);
          fetch(CONFIG_URL, { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (data) { setCfg(data.config); })
            .catch(function (e) { setErr(String(e && e.message ? e.message : e)); });
          return function () { style.remove(); };
        }, []);

        // Every mutation round-trips through the host so the file on disk is
        // always the source of truth; the response is the merged config.
        function patch(p) {
          setErr("");
          return fetch(CONFIG_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(p),
          })
            .then(function (r) {
              if (!r.ok) throw new Error("HTTP " + r.status);
              return r.json();
            })
            .then(function (data) { setCfg(data.config); return data.config; })
            .catch(function (e) { setErr(String(e && e.message ? e.message : e)); });
        }

        function patchScene(scene, field, value) {
          var next = {};
          next[scene] = {};
          next[scene][field] = value;
          return patch({ per: next });
        }

        function preview(scene) {
          setBusy(scene);
          fetch(TEST_URL + "?scene=" + encodeURIComponent(scene), { cache: "no-store" })
            .catch(function (e) { setErr(String(e && e.message ? e.message : e)); })
            .then(function () { setTimeout(function () { setBusy(""); }, 900); });
        }

        if (cfg === null) {
          return h("div", { className: "dsnc-wrap" },
            h("div", { className: "dsnc-note" }, isZh() ? "正在读取配置…" : "Loading configuration…"));
        }

        var master = cfg.notifications !== false;
        var volume = typeof cfg.volume === "number" ? cfg.volume : 1;

        var header = h("div", { className: "dsnc-hd", key: "hd" }, [
          h("span", { className: "dsnc-dot", key: "d" }),
          h("h3", { key: "t" }, isZh() ? "通知" : "Notifications"),
          h("span", { className: "dsnc-sub", key: "s" },
            isZh()
              ? "按结束原因区分提示音；任务栏闪烁可在下方单独关闭"
              : "Distinct chime per end reason; taskbar flash has its own switch below"),
        ]);

        var globalRows = h("div", { className: "dsnc-card", key: "g" }, [
          h(Row, { key: "master", name: isZh() ? "启用提醒" : "Enable notifications",
            hint: isZh() ? "总开关。关掉后不出声、不弹通知、不闪任务栏" : "Master switch — off means no sound, no toast, no flash" },
            h(Toggle, { on: master, onChange: function (v) { patch({ notifications: v }); } })),
          h(Row, { key: "flash", name: isZh() ? "任务栏图标闪烁" : "Flash taskbar button",
            hint: isZh() ? "让任务栏上的 DSH 图标闪烁提示你有事发生；你没在看它时才闪" : "Pulses the DSH taskbar button to get your attention; only while it is in the background" },
            h(Toggle, { on: cfg.flash !== false, disabled: !master, onChange: function (v) { patch({ flash: v }); } })),
          h(Row, { key: "flashAfter", name: isZh() ? "闪完之后" : "After the flash",
            hint: isZh() ? "QQ／微信的做法是「闪几下，然后图标保持高亮，直到你点它」" : "Chat apps flash a few times, then leave the icon lit until you come back" },
            h("select", {
              key: "sel", className: "dsnc-sel", disabled: !master || cfg.flash === false,
              value: typeof cfg.flashAfter === "string" ? cfg.flashAfter : "holdUntilFocused",
              onChange: function (e) { patch({ flashAfter: e.target.value }); },
            }, [
              h("option", { key: "hold", value: "holdUntilFocused" }, isZh() ? "闪几下后保持高亮（默认）" : "Flash, then stay lit (default)"),
              h("option", { key: "stop", value: "stop" }, isZh() ? "闪几下就结束" : "Flash, then stop"),
              h("option", { key: "keep", value: "keepFlashing" }, isZh() ? "一直闪，直到我切回来" : "Keep flashing until I return"),
            ])),
          h(Row, { key: "flashTimeout", name: isZh() ? "闪烁节奏" : "Flash pace",
            hint: isZh() ? "每闪一下的间隔" : "Time per pulse" },
            h("select", {
              key: "sel", className: "dsnc-sel", disabled: !master || cfg.flash === false,
              value: String(typeof cfg.flashTimeout === "number" ? cfg.flashTimeout : 500),
              onChange: function (e) { patch({ flashTimeout: Number(e.target.value) }); },
            }, [
              h("option", { key: "200", value: "200" }, isZh() ? "快（0.2 秒）" : "Fast (0.2s)"),
              h("option", { key: "500", value: "500" }, isZh() ? "正常（0.5 秒，默认）" : "Normal (0.5s, default)"),
              h("option", { key: "1000", value: "1000" }, isZh() ? "慢（1 秒）" : "Slow (1s)"),
            ])),
          h(Row, { key: "toast", name: isZh() ? "系统通知弹窗（toast）" : "System toast popup",
            hint: isZh() ? "Windows 右下角的横幅通知，点它可以切回 DSH" : "The banner in the Windows corner; clicking it returns to DSH" },
            h(Toggle, { on: cfg.toast !== false, disabled: !master, onChange: function (v) { patch({ toast: v }); } })),
          h(Row, { key: "quiet", name: isZh() ? "正在看的那个会话跑完时，不出声" : "Stay quiet when the conversation on screen finishes",
            hint: isZh() ? "只静默你正盯着的那一个会话；别的会话跑完照样提醒，切走窗口也照样提醒" : "Silences only the conversation you are reading; another one finishing still alerts, and so does switching away" },
            h(Toggle, { on: cfg.quietOnForeground !== false, disabled: !master, onChange: function (v) { patch({ quietOnForeground: v }); } })),
          h(Row, { key: "attn", name: isZh() ? "提问和审批，你正看着也提醒" : "Questions and approvals alert even while you watch",
            hint: isZh() ? "这类是 agent 卡住等你操作，不受上面那项影响" : "The agent is blocked on you; this ignores the setting above" },
            h(Toggle, { on: cfg.alwaysNotifyAttention !== false, disabled: !master, onChange: function (v) { patch({ alwaysNotifyAttention: v }); } })),
          h(Row, { key: "vol", name: isZh() ? "音量" : "Volume",
            hint: isZh() ? "只影响我自己合成的提示音，不影响系统通知本身的音量" : "Affects the synthesized chime only, not the system notification's own sound" },
            h("div", { className: "dsnc-vol" }, [
              h("input", {
                key: "r", type: "range", min: 10, max: 100, step: 5,
                value: Math.round(volume * 100),
                disabled: !master,
                onChange: function (e) { patch({ volume: Number(e.target.value) / 100 }); },
              }),
              h("span", { className: "dsnc-val", key: "v" }, Math.round(volume * 100) + "%"),
            ])),
        ]);

        var sceneRows = h("div", { key: "scenes" }, [
          h("div", { className: "dsnc-sec", key: "t" }, isZh() ? "分场景提示音" : "Sound per situation"),
          h("div", { className: "dsnc-card", key: "c" },
            SCENES.map(function (scene) {
              var entry = (cfg.per && cfg.per[scene.key]) || {};
              var enabled = entry.enabled !== false;
              var sound = typeof entry.sound === "string" ? entry.sound : scene.key;
              // A custom absolute path is not in the list; surface it as an extra option.
              var isCustom = /[\\/]/.test(sound);
              return h(Row, {
                key: scene.key,
                name: label(scene),
                hint: hint(scene),
              }, [
                h("select", {
                  key: "sel",
                  className: "dsnc-sel",
                  value: isCustom ? "__custom" : sound,
                  disabled: !master || !enabled,
                  onChange: function (e) {
                    if (e.target.value === "__custom") return;
                    patchScene(scene.key, "sound", e.target.value);
                  },
                }, (isCustom
                  ? SOUNDS.concat([{ id: "__custom", zh: "自定义文件", en: "Custom file" }])
                  : SOUNDS
                ).map(function (s) {
                  return h("option", { key: s.id, value: s.id }, label(s));
                })),
                h("button", {
                  key: "play",
                  className: "dsnc-play",
                  disabled: !master || !enabled || sound === "none",
                  title: isZh() ? "试听" : "Preview",
                  onClick: function () { preview(scene.key); },
                }, busy === scene.key ? "…" : "▶"),
                h(Toggle, {
                  key: "sw",
                  on: enabled,
                  disabled: !master,
                  onChange: function (v) { patchScene(scene.key, "enabled", v); },
                }),
              ]);
            })),
        ]);

        var footer = h("div", { key: "f" }, [
          h("div", { className: "dsnc-note", key: "n" }, isZh()
            ? "提示音由内置合成器生成，不依赖任何音频文件或 .NET 运行时。配置保存在 ~/.dsh/dsh-notify-cues.json，修改即时生效。"
            : "Chimes are synthesized in PowerShell — no audio assets and no .NET runtime needed. Config lives in ~/.dsh/dsh-notify-cues.json and applies immediately."),
          err ? h("div", { className: "dsnc-err", key: "e" }, err) : null,
        ]);

        return h("div", { className: "dsnc-wrap" }, [header, globalRows, sceneRows, footer]);
      }

      function CuesSettingsSection(props) {
        // The section itself is a nav entry; its content is the child slot it
        // declared, which is where CuesPanel is registered.
        return h("div", { style: { padding: "0 4px" } },
          props.renderSlot ? props.renderSlot("dsh-notify-cues.content", {}) : null);
      }

      function apply(ctx) {
        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register({
            name: "settings.section",
            id: "dsh-notify-cues",
            order: 40,
            label: function () { return isZh() ? "通知" : "Notifications"; },
            children: {
              "dsh-notify-cues.content": { kind: "list", scope: "root" },
            },
          }, CuesSettingsSection);
        });
        ctx.slots.inject("dsh-notify-cues.content", function () {
          return ctx.slots.register({
            name: "dsh-notify-cues.content",
            id: "panel",
          }, CuesPanel);
        });
        // Session-scoped: this is the only place that knows WHICH session the
        // main view is showing, which is what makes "another conversation
        // finished" still notify.
        ctx.slots.inject("conversation.session.header.utilities", function () {
          return ctx.slots.register({
            name: "conversation.session.header.utilities",
            id: "dsh-notify-cues-presence",
            order: 900,
          }, PresenceReporter);
        });
      }

      exports.apply = apply;
      exports.inject = ["slots"];
    })();
    return module.exports;
  }
});
