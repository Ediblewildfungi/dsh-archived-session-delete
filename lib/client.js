/**
 * Browser half of `dsh-archived-session-delete`.
 *
 * Contributes two slots:
 * - `sidebar.workspaces.session.menu.item` — a "删除会话" row that is only
 *   rendered for archived sessions (it reads the registry-global archive set
 *   from the Workspace snapshot).
 * - `shell.overlay` — the second-confirmation dialog. Confirming calls the
 *   Host half's authenticated Connection RPC channel and then refreshes the
 *   Client session list.
 *
 * The shipped web shell loads dynamic client plugins as lazy CommonJS
 * factories: executing the bundle only registers this factory, whose body
 * (CSS injection, dictionaries, slots) runs when the plugin is materialized.
 * The bundle imports only modules from the shell's frozen platform table
 * (`react`, `@deepseek-ai/dsh-client-store`,
 * `@deepseek-ai/dsh-client-ui-primitives`), so no build step or extra
 * `dsh.client.external` entry is needed.
 */
window.__ModuleLoader__.load({
  id: 'dsh-archived-session-delete',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    var clientStore = require('@deepseek-ai/dsh-client-store');
    var h = React.createElement;
    var MenuItemButton = primitives.MenuItemButton;
    var Modal = primitives.Modal;
    var Button = primitives.Button;
    var IconTrashOutlineRegular = primitives.IconTrashOutlineRegular;
    var createSnapshotStore = clientStore.createSnapshotStore;

    var NS = 'archivedSessionDelete';
    var CHANNEL = '/archived-session-delete';

    //#region styles
    var css = '' +
      '.dsd-error{color:var(--dsw-alias-state-error-primary);margin-top:8px;font-size:12px;line-height:18px}' +
      '.dsd-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}' +
      '.dsd-delete-action:not(:disabled){color:var(--dsw-alias-state-error-primary)}';
    var cssTagId = 'dsh-archived-session-delete/style.css';
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(cssTagId) + ']') === null) {
      var styleTag = document.createElement('style');
      styleTag.dataset.plugin = 'dsh-archived-session-delete';
      styleTag.dataset.pluginCss = cssTagId;
      styleTag.textContent = css;
      document.head.appendChild(styleTag);
    }
    //#endregion

    //#region locale
    var zh = {
      'menu.delete': '删除会话',
      'dialog.title': '删除会话',
      'dialog.description': '确定要永久删除已归档的会话「{title}」吗？该会话在本地的记录会被删除，且无法恢复。',
      'dialog.cancel': '取消',
      'dialog.confirm': '删除',
      'dialog.deleting': '正在删除…',
      'error.notArchived': '只能删除已归档的会话。',
      'error.sessionActive': '该会话仍在运行或正在被打开，暂时无法删除。',
      'error.notFound': '找不到该会话的本地记录，可能已被删除。',
      'error.unsafePath': '会话文件路径异常，已拒绝删除。',
      'error.failed': '删除失败：{message}',
      'error.transport': '无法连接 Host：{message}',
    };
    var en = {
      'menu.delete': 'Delete session',
      'dialog.title': 'Delete session',
      'dialog.description': 'Permanently delete the archived session “{title}”? Its local records will be removed and cannot be recovered.',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete',
      'dialog.deleting': 'Deleting…',
      'error.notArchived': 'Only archived sessions can be deleted this way.',
      'error.sessionActive': 'This session is running or open and cannot be deleted right now.',
      'error.notFound': 'The stored session was not found; it may already be deleted.',
      'error.unsafePath': 'The session log path looks unsafe, so deletion was refused.',
      'error.failed': 'Deletion failed: {message}',
      'error.transport': 'Cannot reach the Host: {message}',
    };
    //#endregion

    /** Project one observable into another, recomputing only when the source snapshot identity changes. */
    function derive(source, project) {
      var seen;
      var value;
      return {
        getSnapshot: function () {
          var snapshot = source.getSnapshot();
          if (value === undefined || snapshot !== seen) {
            seen = snapshot;
            value = project(snapshot);
          }
          return value;
        },
        subscribe: function (listener) {
          return source.subscribe(listener);
        },
      };
    }

    /** Map a Host business failure to localized copy. */
    function errorMessage(t, result) {
      var error = result !== null && result !== undefined && result.error !== undefined && result.error !== null
        ? result.error
        : { code: 'internal', message: '' };
      switch (error.code) {
        case 'not-archived':
          return t('error.notArchived');
        case 'session-active':
          return t('error.sessionActive');
        case 'not-found':
          return t('error.notFound');
        case 'unsafe-path':
          return t('error.unsafePath');
        default:
          return t('error.failed', { message: error.message || error.code || 'unknown' });
      }
    }

    /**
     * Menu row (order 500, after the built-in Session ID action): delete an
     * archived session. Rendered only for archived rows; selecting it closes
     * the menu and raises the confirmation request.
     */
    function DeleteArchivedSessionMenuItem(props) {
      var t = props.t;
      var sessionId = props.sessionId;
      var displayTitle = props.displayTitle;
      var archived = props.useArchived(function (set) {
        return set.has(sessionId);
      });
      var menuState = props.useMenuOpenState();
      var setMenuOpen = menuState[1];
      if (!archived) return null;
      return h(MenuItemButton, {
        icon: h(IconTrashOutlineRegular, { size: 14 }),
        separatorBefore: true,
        onSelect: function () {
          setMenuOpen(false);
          props.requestDelete(sessionId, displayTitle);
        },
      }, t('menu.delete'));
    }

    /** Overlay seat: renders one confirmation dialog while a request is pending. */
    function DeleteArchivedSessionDialog(props) {
      var pending = props.useDeleteRequest(function (value) {
        return value;
      });
      if (pending === null || pending === undefined) return null;
      return h(DeleteArchivedSessionConfirm, {
        key: pending.sessionId,
        request: pending,
        t: props.t,
        cancelDelete: props.cancelDelete,
        deleteSession: props.deleteSession,
      });
    }

    /** One request's dialog; in-flight and error state die with it. */
    function DeleteArchivedSessionConfirm(props) {
      var t = props.t;
      var deletingState = React.useState(false);
      var deleting = deletingState[0];
      var setDeleting = deletingState[1];
      var errorState = React.useState(null);
      var error = errorState[0];
      var setError = errorState[1];

      function close() {
        if (deleting) return;
        props.cancelDelete();
      }

      function confirm() {
        if (deleting) return;
        setDeleting(true);
        setError(null);
        Promise.resolve()
          .then(function () {
            return props.deleteSession(props.request.sessionId);
          })
          .then(function (result) {
            if (result !== null && result !== undefined && result.ok === true) {
              props.cancelDelete();
              return;
            }
            setDeleting(false);
            setError(errorMessage(t, result));
          }, function (reason) {
            setDeleting(false);
            setError(t('error.transport', { message: String(reason !== null && reason !== undefined && reason.message ? reason.message : reason) }));
          });
      }

      return h(Modal, {
        open: true,
        onClose: close,
        closeLabel: t('dialog.cancel'),
        title: t('dialog.title'),
        description: t('dialog.description', { title: props.request.title }),
        footer: [
          h(Button, {
            key: 'cancel',
            variant: 'outline',
            disabled: deleting,
            onClick: close,
          }, t('dialog.cancel')),
          h(Button, {
            key: 'delete',
            variant: 'outline',
            className: 'dsd-delete-action',
            disabled: deleting,
            onClick: confirm,
          }, t('dialog.confirm')),
        ],
      },
      deleting ? h('div', { className: 'dsd-status', role: 'status' }, t('dialog.deleting')) : null,
      error !== null ? h('div', { className: 'dsd-error', role: 'alert' }, error) : null);
    }

    /** Services the browser half waits for before registering its slots. */
    var inject = ['slots', 'locale', 'sessions', 'workspaces', 'connection'];

    /**
     * Client plugin body: register dictionaries, the archived-row menu item and
     * the confirmation overlay.
     * @param ctx - client root Context.
     */
    function apply(ctx) {
      var workspaces = ctx.get('workspaces');
      var sessions = ctx.get('sessions');
      var connection = ctx.get('connection');
      var request = createSnapshotStore(null);
      var archivedSet = derive(workspaces.list, function (snapshot) {
        return new Set(snapshot.archivedSessionIds);
      });

      function requestDelete(sessionId, title) {
        request.set({
          sessionId: sessionId,
          title: typeof title === 'string' && title.length > 0 ? title : sessionId,
        });
      }

      function deleteArchivedSession(sessionId) {
        return Promise.resolve(connection.rpc.call(CHANNEL, 'delete', { sessionId: sessionId })).then(function (result) {
          if (result !== null && result !== undefined && result.ok === true) {
            // The Host forwarded `api-session/removed`; pull the fresh list too
            // so the deleted row also leaves the client session catalog.
            try {
              sessions.refresh();
            } catch (error) {
              console.warn('[archived-session-delete] session list refresh failed:', error);
            }
          }
          return result;
        }, function (error) {
          return { ok: false, error: { code: 'transport', message: String(error !== null && error !== undefined && error.message ? error.message : error) } };
        });
      }

      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, 'archived-session-delete: dictionaries');

      ctx.slots.inject('sidebar.workspaces.session.menu.item', function () {
        return ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'archived-session-delete',
          order: 500,
          locale: NS,
          inject: function () {
            return {
              hooks: { archived: archivedSet },
              requestDelete: requestDelete,
            };
          },
        }, DeleteArchivedSessionMenuItem);
      });

      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: 'archived-session-delete.dialog',
          locale: NS,
          inject: function () {
            return {
              hooks: { deleteRequest: request },
              cancelDelete: function () {
                request.set(null);
              },
              deleteSession: deleteArchivedSession,
            };
          },
        }, DeleteArchivedSessionDialog);
      });
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
