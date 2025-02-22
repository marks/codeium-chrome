import { JupyterFrontEnd } from '@jupyterlab/application';
import type * as monaco from 'monaco-editor';

import { addListeners } from './codemirror';
import { CodeMirrorState } from './codemirrorInject';
import { inject as jupyterInject } from './jupyterInject';
import { getPlugin } from './jupyterlabPlugin';
import { MonacoCompletionProvider, MonacoSite, OMonacoSite } from './monacoCompletionProvider';

declare type Monaco = typeof import('monaco-editor');
declare type CodeMirror = typeof import('codemirror');

const params = new URLSearchParams((document.currentScript as HTMLScriptElement).src.split('?')[1]);
const extensionId = params.get('id')!;

// Clear any bad state from another tab.
chrome.runtime.sendMessage(extensionId, { type: 'success' });

const SUPPORTED_MONACO_SITES = new Map<RegExp, MonacoSite>([
  [/https:\/\/colab.research\.google\.com\/.*/, OMonacoSite.COLAB],
  [/https:\/\/(.*\.)?stackblitz\.com\/.*/, OMonacoSite.STACKBLITZ],
  [/https:\/\/(.*\.)?deepnote\.com\/.*/, OMonacoSite.DEEPNOTE],
  [/https:\/\/(.*\.)?(databricks\.com|azuredatabricks\.net)\/.*/, OMonacoSite.DATABRICKS],
  [/https:\/\/(.*\.)?quadratichq\.com\/.*/, OMonacoSite.QUADRATIC],
]);

declare global {
  interface Window {
    _monaco?: Monaco;
    _MonacoEnvironment?: monaco.Environment;
  }
}

// Intercept creation of monaco so we don't have to worry about timing the injection.
let injectMonaco: MonacoSite = OMonacoSite.UNSPECIFIED;
for (const [pattern, site] of SUPPORTED_MONACO_SITES) {
  if (pattern.test(window.location.href)) {
    injectMonaco = site;
    break;
  }
}
if (injectMonaco !== OMonacoSite.UNSPECIFIED) {
  Object.defineProperties(window, {
    MonacoEnvironment: {
      get() {
        if (this._codeium_MonacoEnvironment === undefined) {
          this._codeium_MonacoEnvironment = { globalAPI: true };
        }
        return this._codeium_MonacoEnvironment;
      },
      set(env: monaco.Environment | undefined) {
        if (env !== undefined) {
          env.globalAPI = true;
        }
        this._codeium_MonacoEnvironment = env;
      },
    },
    monaco: {
      get(): Monaco | undefined {
        return this._codeium_monaco;
      },
      set(_monaco: Monaco) {
        const completionProvider = new MonacoCompletionProvider(extensionId, injectMonaco);
        _monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, completionProvider);
        _monaco.editor.registerCommand(
          'codeium.acceptCompletion',
          (_: unknown, apiKey: string, completionId: string, callback?: () => void) => {
            callback?.();
            completionProvider.acceptedLastCompletion(apiKey, completionId);
          }
        );
        _monaco.editor.onDidCreateEditor((editor: monaco.editor.ICodeEditor) => {
          completionProvider.addEditor(editor);
        });
        this._codeium_monaco = _monaco;
        console.log('Activated Codeium');
      },
    },
  });
}

const jupyterConfigDataElement = document.getElementById('jupyter-config-data');
if (jupyterConfigDataElement !== null) {
  const config = JSON.parse(jupyterConfigDataElement.innerText);
  config.exposeAppInBrowser = true;
  jupyterConfigDataElement.innerText = JSON.stringify(config);
  Object.defineProperty(window, 'jupyterapp', {
    get: function () {
      return this._codeium_jupyterapp;
    },
    set: function (_jupyterapp?: JupyterFrontEnd) {
      if (_jupyterapp?.version.startsWith('3.')) {
        const p = getPlugin(extensionId, _jupyterapp);
        _jupyterapp.registerPlugin(p);
        _jupyterapp.activatePlugin(p.id);
        console.log('Activated Codeium');
      } else {
        chrome.runtime.sendMessage(extensionId, {
          type: 'error',
          message: 'Only JupyterLab 3.x is supported',
        });
      }
      this._codeium_jupyterapp = _jupyterapp;
    },
  });
}

const SUPPORTED_CODEMIRROR_SITES = [
  { pattern: /https?:\/\/(.*\.)?jsfiddle\.net(\/.*)?/, multiplayer: false },
  { pattern: /https:\/\/(.*\.)?codepen\.io(\/.*)?/, multiplayer: false },
  { pattern: /https:\/\/(.*\.)?codeshare\.io(\/.*)?/, multiplayer: true },
];

Object.defineProperty(window, 'CodeMirror', {
  get: function () {
    return this._codeium_CodeMirror;
  },
  set: function (cm?: { version?: string }) {
    this._codeium_CodeMirror = cm;
    if (!cm?.version?.startsWith('5.')) {
      console.warn("Codeium doesn't support CodeMirror 6");
      return;
    }
    // We rely on the fact that the Jupyter variable is defined first.
    if (Object.prototype.hasOwnProperty.call(this, 'Jupyter')) {
      const jupyterState = jupyterInject(extensionId, this.Jupyter);
      addListeners(cm as CodeMirror, jupyterState.codeMirrorManager);
    } else {
      let injectCodeMirror = false;
      let multiplayer = false;
      for (const pattern of SUPPORTED_CODEMIRROR_SITES) {
        if (pattern.pattern.test(window.location.href)) {
          injectCodeMirror = true;
          multiplayer = pattern.multiplayer;
          break;
        }
      }
      if (injectCodeMirror) {
        new CodeMirrorState(extensionId, cm as CodeMirror, multiplayer);
        console.log('Activated Codeium');
      }
    }
  },
});

// In this case, the CodeMirror 5 editor is accessible as a property of elements
// with the class CodeMirror.
const SUPPORTED_CODEMIRROR_NONGLOBAL_SITES = [
  { pattern: /https:\/\/console\.paperspace\.com\/.*\/notebook\/.*/, notebook: true },
  { pattern: /https?:\/\/www\.codewars\.com(\/.*)?/, notebook: false },
  { pattern: /https:\/\/(.*\.)?github\.com(\/.*)?/, notebook: false },
];
for (const pattern of SUPPORTED_CODEMIRROR_NONGLOBAL_SITES) {
  if (pattern.pattern.test(window.location.href)) {
    const codeMirrorState = new CodeMirrorState(extensionId, undefined, false);
    const hook = codeMirrorState.editorHook();
    setInterval(() => {
      const docsByPosition = new Map<CodeMirror.Doc, number>();
      for (const el of document.getElementsByClassName('CodeMirror')) {
        const maybeCodeMirror = el as { CodeMirror?: CodeMirror.Editor };
        if (maybeCodeMirror.CodeMirror === undefined) {
          continue;
        }
        const editor = maybeCodeMirror.CodeMirror;
        hook(editor);
        if (pattern.notebook) {
          docsByPosition.set(editor.getDoc(), (el as HTMLElement).getBoundingClientRect().top);
        }
      }
      if (pattern.notebook) {
        const docs = [...docsByPosition.entries()].sort((a, b) => a[1] - b[1]).map(([doc]) => doc);
        codeMirrorState.docs = docs;
      }
    }, 100);
  }
}
