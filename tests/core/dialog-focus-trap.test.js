/**
 * Unit & Integration tests for PBFDialog.trapFocus (WCAG 2.1 AA focus trap, sibling inert, Escape, and restoration)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dialogSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'dialog.js'), 'utf8');

function createDOMFixture() {
  let activeElement = null;

  class FakeNode {
    constructor(tagName) {
      this.tagName = tagName ? tagName.toUpperCase() : 'DIV';
      this.nodeType = 1;
      this.children = [];
      this.parentElement = null;
      this.parentNode = null;
      this.attributes = {};
      this.classList = new Set();
      this.style = {};
      this.tabIndex = 0;
      this.inert = false;
      this.disabled = false;
      this.offsetWidth = 100;
      this.offsetHeight = 30;
      this._eventListeners = {};
    }

    getAttribute(name) {
      return this.attributes[name] || null;
    }

    setAttribute(name, val) {
      this.attributes[name] = String(val);
      if (name === 'tabindex') this.tabIndex = parseInt(val, 10);
      if (name === 'disabled') this.disabled = true;
    }

    removeAttribute(name) {
      delete this.attributes[name];
      if (name === 'disabled') this.disabled = false;
    }

    appendChild(child) {
      child.parentElement = this;
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) {
        this.children.splice(idx, 1);
        child.parentElement = null;
        child.parentNode = null;
      }
      return child;
    }

    getClientRects() {
      return [{ width: this.offsetWidth, height: this.offsetHeight }];
    }

    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    }

    focus() {
      activeElement = this;
    }

    addEventListener(event, handler) {
      if (!this._eventListeners[event]) this._eventListeners[event] = [];
      this._eventListeners[event].push(handler);
    }

    removeEventListener(event, handler) {
      if (!this._eventListeners[event]) return;
      this._eventListeners[event] = this._eventListeners[event].filter((h) => h !== handler);
    }

    dispatchEvent(evt) {
      const list = this._eventListeners[evt.type] || [];
      for (const h of list) h(evt);
    }

    querySelectorAll(sel) {
      const results = [];
      function walk(node) {
        for (const c of node.children) {
          if (sel.includes('button') && c.tagName === 'BUTTON' && !c.disabled) {
            results.push(c);
          } else if (sel.includes('input') && c.tagName === 'INPUT' && !c.disabled) {
            results.push(c);
          } else if (sel.includes('[tabindex]') && c.tabIndex >= 0) {
            results.push(c);
          }
          walk(c);
        }
      }
      walk(this);
      return results;
    }

    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
  }

  const body = new FakeNode('BODY');
  const main = new FakeNode('MAIN');
  const aside = new FakeNode('ASIDE');
  const footer = new FakeNode('FOOTER');
  body.appendChild(main);
  body.appendChild(aside);
  body.appendChild(footer);

  const buttonOutside = new FakeNode('BUTTON');
  main.appendChild(buttonOutside);

  const modalContainer = new FakeNode('DIV');
  modalContainer.setAttribute('role', 'dialog');
  const btn1 = new FakeNode('BUTTON');
  const btn2 = new FakeNode('BUTTON');
  modalContainer.appendChild(btn1);
  modalContainer.appendChild(btn2);
  body.appendChild(modalContainer);

  const documentListeners = {};
  const fakeDoc = {
    body: body,
    activeElement: buttonOutside,
    createElement: (tag) => new FakeNode(tag),
    addEventListener: (evt, fn) => {
      if (!documentListeners[evt]) documentListeners[evt] = [];
      documentListeners[evt].push(fn);
    },
    removeEventListener: (evt, fn) => {
      if (!documentListeners[evt]) return;
      documentListeners[evt] = documentListeners[evt].filter((f) => f !== fn);
    },
    dispatchEvent: (evt) => {
      const list = documentListeners[evt.type] || [];
      for (const fn of list) fn(evt);
    }
  };

  const fakeWin = {
    document: fakeDoc,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    API: { t: (k, fb) => fb }
  };

  return {
    window: fakeWin,
    document: fakeDoc,
    body,
    main,
    aside,
    footer,
    buttonOutside,
    modalContainer,
    btn1,
    btn2,
    getActiveElement: () => activeElement,
    setActiveElement: (el) => { activeElement = el; }
  };
}

function registerDialogFocusTrapTests() {
test('PBFDialog.trapFocus: manages inert on siblings, cycles Tab, and handles Escape', async (_t) => {
  const fx = createDOMFixture();
  const sandbox = {
    window: fx.window,
    document: fx.document,
    setTimeout: (fn) => fn(),
    module: { exports: {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(dialogSrc, sandbox);
  const PBFDialog = sandbox.window.PBFDialog;

  assert.equal(typeof PBFDialog.trapFocus, 'function', 'PBFDialog exports trapFocus');

  fx.setActiveElement(fx.buttonOutside);

  let escapeTriggered = false;
  const trap = PBFDialog.trapFocus(fx.modalContainer, {
    triggerEl: fx.buttonOutside,
    escape: true,
    onEscape: () => {
      escapeTriggered = true;
    },
    siblingInert: true,
    initialFocus: fx.btn1
  });

  // 1. Siblings of modalContainer under body should have inert = true
  assert.equal(fx.main.inert, true, 'main sibling is inert');
  assert.equal(fx.aside.inert, true, 'aside sibling is inert');
  assert.equal(fx.footer.inert, true, 'footer sibling is inert');
  assert.equal(fx.modalContainer.inert, false, 'modal container itself is not inert');

  // 2. Escape triggers onEscape callback
  let defaultPrevented = false;
  let propagationStopped = false;
  fx.document.dispatchEvent({
    type: 'keydown',
    key: 'Escape',
    preventDefault: () => { defaultPrevented = true; },
    stopPropagation: () => { propagationStopped = true; }
  });
  assert.equal(escapeTriggered, true, 'Escape key triggers onEscape');
  assert.equal(defaultPrevented, true, 'Escape default prevented');
  assert.equal(propagationStopped, true, 'Escape propagation stopped');

  // 3. Tab cycling
  fx.setActiveElement(fx.btn2);
  let tabPrevented = false;
  fx.document.dispatchEvent({
    type: 'keydown',
    key: 'Tab',
    shiftKey: false,
    preventDefault: () => { tabPrevented = true; }
  });
  assert.equal(tabPrevented, true, 'Forward Tab wraps to first focusable element');
  assert.equal(fx.getActiveElement(), fx.btn1, 'Focus cycled from btn2 to btn1');

  // Shift+Tab cycling
  fx.setActiveElement(fx.btn1);
  let shiftTabPrevented = false;
  fx.document.dispatchEvent({
    type: 'keydown',
    key: 'Tab',
    shiftKey: true,
    preventDefault: () => { shiftTabPrevented = true; }
  });
  assert.equal(shiftTabPrevented, true, 'Backward Shift+Tab wraps to last element');
  assert.equal(fx.getActiveElement(), fx.btn2, 'Focus cycled from btn1 to btn2');

  // 4. Release cleans up inert and restores focus to triggerEl
  trap.release();
  assert.equal(fx.main.inert, false, 'main is no longer inert');
  assert.equal(fx.aside.inert, false, 'aside is no longer inert');
  assert.equal(fx.footer.inert, false, 'footer is no longer inert');
  assert.equal(fx.getActiveElement(), fx.buttonOutside, 'Focus restored to buttonOutside');
});
}

if (require.main === module) {
  registerDialogFocusTrapTests();
}
module.exports = registerDialogFocusTrapTests;
