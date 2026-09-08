/**
 * Interface de l'agenda familial.
 * Aucune dépendance ni étape de build : modules ES natifs.
 */

const state = {
  members: [],
  events: [],
  accounts: [],
  providers: [],
  notifications: [],
  settings: { reminderHour: 8, timezone: 'Europe/Paris', emailEnabled: false, offsets: [] },
  timezone: 'Europe/Paris',
  memberFilter: '',
  cursor: null, // { year, month } affiché
};

const el = (id) => document.getElementById(id);
const DAY_MS = 86_400_000;

// ─── Accès API ───────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Erreur ${response.status}`);
  }
  return payload;
}

// ─── Dates : tout est affiché dans le fuseau du foyer ────────────────────────

const formatterCache = new Map();

function partsFormatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    // 'sv-SE' produit un format « YYYY-MM-DD HH:mm », directement exploitable.
    formatterCache.set(
      timeZone,
      new Intl.DateTimeFormat('sv-SE', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }),
    );
  }
  return formatterCache.get(timeZone);
}

/** Instant UTC -> "YYYY-MM-DDTHH:mm" dans le fuseau du foyer. */
function toLocalInput(iso, timeZone = state.timezone) {
  return partsFormatter(timeZone).format(new Date(iso)).replace(' ', 'T');
}

/** Instant UTC -> clé de jour "YYYY-MM-DD" dans le fuseau du foyer. */
function dateKey(iso, timeZone = state.timezone) {
  return toLocalInput(iso, timeZone).slice(0, 10);
}

function timeLabel(iso) {
  return toLocalInput(iso).slice(11, 16).replace(':', 'h');
}

function humanDate(iso, options = {}) {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: state.timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    ...options,
  }).format(new Date(iso));
}

function addDaysToKey(key, days) {
  const [year, month, day] = key.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/** Jours couverts par un événement (la fin d'un « journée entière » est exclusive). */
function eventDateKeys(event) {
  const first = dateKey(event.starts_at);
  const endMs = new Date(event.ends_at).getTime() - (event.all_day ? 60_000 : 0);
  const last = dateKey(new Date(Math.max(endMs, new Date(event.starts_at).getTime())).toISOString());
  const keys = [first];
  let cursor = first;
  while (cursor < last && keys.length < 400) {
    cursor = addDaysToKey(cursor, 1);
    keys.push(cursor);
  }
  return keys;
}

function todayKey() {
  return dateKey(new Date().toISOString());
}

// ─── Chargement des données ──────────────────────────────────────────────────

function gridRange() {
  const { year, month } = state.cursor;
  const first = new Date(Date.UTC(year, month - 1, 1));
  const mondayOffset = (first.getUTCDay() + 6) % 7;
  const start = new Date(first.getTime() - mondayOffset * DAY_MS);
  const end = new Date(start.getTime() + 42 * DAY_MS);
  return { start, end };
}

async function loadAll() {
  const { start, end } = gridRange();
  const now = Date.now();
  // La fenêtre couvre la grille affichée et les deux prochains mois (« Prochaines dates »).
  const from = new Date(Math.min(start.getTime(), now)).toISOString();
  const to = new Date(Math.max(end.getTime(), now + 60 * DAY_MS)).toISOString();

  const query = new URLSearchParams({ from, to });
  if (state.memberFilter) query.set('memberId', state.memberFilter);

  const [members, events, accounts, notifications] = await Promise.all([
    api('/members'),
    api(`/events?${query}`),
    api('/accounts'),
    api(`/notifications${state.memberFilter ? `?memberId=${state.memberFilter}` : ''}`),
  ]);

  state.members = members.members;
  state.events = events.events;
  state.accounts = accounts.accounts;
  state.providers = accounts.providers;
  state.timezone = accounts.timezone || state.timezone;
  state.notifications = notifications.notifications;
  state.settings = notifications.settings;
  render();
}

// ─── Rendu ───────────────────────────────────────────────────────────────────

function render() {
  renderSubtitle();
  renderMemberFilter();
  renderCalendar();
  renderUpcoming();
  renderAccounts();
  renderReminderInfo();
  renderMembers();
  renderNotifications();
}

function renderSubtitle() {
  const linked = state.accounts.filter((account) => account.sync_enabled).length;
  const hour = String(state.settings.reminderHour).padStart(2, '0');
  el('topbar-subtitle').textContent =
    `${state.events.length} date(s) · ${linked} agenda(s) synchronisé(s) · rappels à ${hour}h00 (${state.timezone})`;
}

function renderMemberFilter() {
  const select = el('member-filter');
  const current = state.memberFilter;
  select.innerHTML = '<option value="">Tout le foyer</option>';
  for (const member of state.members) {
    const option = document.createElement('option');
    option.value = String(member.id);
    option.textContent = member.name;
    select.append(option);
  }
  select.value = current;
}

function memberColor(memberId) {
  return state.members.find((member) => member.id === memberId)?.color ?? '#4f7cff';
}

function sourceTag(source) {
  if (source === 'google') return '<span class="tag google">Google</span>';
  if (source === 'outlook') return '<span class="tag outlook">Outlook</span>';
  return '';
}

function renderCalendar() {
  const { year, month } = state.cursor;
  el('month-label').textContent = new Intl.DateTimeFormat('fr-FR', {
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, 1)));

  const byDay = new Map();
  for (const event of state.events) {
    for (const key of eventDateKeys(event)) {
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(event);
    }
  }

  const { start } = gridRange();
  const grid = el('calendar-grid');
  grid.innerHTML = '';
  const today = todayKey();

  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start.getTime() + index * DAY_MS);
    const key = date.toISOString().slice(0, 10);
    // La sixième semaine n'est affichée que si elle contient encore le mois courant.
    if (index >= 35 && date.getUTCMonth() + 1 !== month) continue;

    const cell = document.createElement('div');
    cell.className = 'day';
    if (date.getUTCMonth() + 1 !== month) cell.classList.add('other-month');
    if (key === today) cell.classList.add('today');
    cell.dataset.day = key;

    const number = document.createElement('div');
    number.className = 'day-number';
    number.textContent = String(date.getUTCDate());
    cell.append(number);

    const dayEvents = (byDay.get(key) ?? []).sort((a, b) =>
      a.starts_at < b.starts_at ? -1 : 1,
    );
    for (const event of dayEvents.slice(0, 3)) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.style.borderLeftColor = memberColor(event.owner_member_id);
      chip.title = `${event.title}${event.location ? ` — ${event.location}` : ''}`;
      chip.innerHTML = event.all_day
        ? `<span class="chip-src">${event.title}</span>`
        : `<span class="chip-time">${timeLabel(event.starts_at)}</span>${event.title}`;
      chip.addEventListener('click', (clickEvent) => {
        clickEvent.stopPropagation();
        openEventDialog(event);
      });
      cell.append(chip);
    }
    if (dayEvents.length > 3) {
      const more = document.createElement('div');
      more.className = 'day-more';
      more.textContent = `+ ${dayEvents.length - 3} autre(s)`;
      cell.append(more);
    }

    cell.addEventListener('click', () => openEventDialog(null, key));
    grid.append(cell);
  }
}

function renderUpcoming() {
  const list = el('upcoming');
  const now = Date.now();
  const upcoming = state.events
    .filter((event) => new Date(event.ends_at).getTime() >= now)
    .sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1))
    .slice(0, 8);

  list.innerHTML = '';
  if (upcoming.length === 0) {
    list.innerHTML = '<p class="empty">Aucune date à venir. Cliquez sur un jour pour en ajouter une.</p>';
    return;
  }

  for (const event of upcoming) {
    const item = document.createElement('li');
    item.style.borderLeftColor = memberColor(event.owner_member_id);
    const when = event.all_day
      ? humanDate(event.starts_at)
      : `${humanDate(event.starts_at)} · ${timeLabel(event.starts_at)}`;
    const pending = event.reminders.filter((reminder) => reminder.status === 'pending').length;
    item.innerHTML = `
      <span class="when">${when}</span>
      <span class="what">${escapeHtml(event.title)}</span>
      <span class="tags">
        ${sourceTag(event.source)}
        ${event.links.map((link) => `<span class="tag ${link.provider}">↗ ${link.kind === 'pro' ? 'pro' : 'perso'}</span>`).join('')}
        <span class="tag">${pending} rappel(s) à venir</span>
      </span>`;
    item.addEventListener('click', () => openEventDialog(event));
    list.append(item);
  }
}

function renderAccounts() {
  const container = el('accounts-list');
  container.innerHTML = '';

  if (state.accounts.length === 0) {
    container.innerHTML =
      '<p class="empty">Aucun compte relié. Utilisez les boutons ci-dessous pour connecter Google (perso) et Outlook (pro).</p>';
  }

  for (const account of state.accounts) {
    const card = document.createElement('div');
    card.className = 'account';
    const kindLabel = account.kind === 'pro' ? 'pro' : 'perso';
    const memberOptions = [
      `<option value="">Personne</option>`,
      ...state.members.map(
        (member) =>
          `<option value="${member.id}" ${member.id === account.member_id ? 'selected' : ''}>${escapeHtml(member.name)}</option>`,
      ),
    ].join('');

    card.innerHTML = `
      <div class="account-head">
        <span class="tag ${account.provider}">${account.provider === 'google' ? 'Google' : 'Outlook'}</span>
        <strong>${escapeHtml(account.account_email || account.display_name)}</strong>
        <span class="tag">${kindLabel}</span>
      </div>
      <div class="account-meta">
        Agenda : ${escapeHtml(account.calendar_name || account.calendar_id || 'principal')}
        ${account.last_sync_at ? ` · dernière synchro ${escapeHtml(account.last_sync_at)}` : ''}
      </div>
      ${account.last_sync_error ? `<div class="account-error">⚠️ ${escapeHtml(account.last_sync_error)}</div>` : ''}
      <div class="account-controls">
        <label class="checkbox small">
          <input type="checkbox" data-role="enabled" ${account.sync_enabled ? 'checked' : ''} />
          <span>Active</span>
        </label>
        <select data-role="direction" aria-label="Sens de synchronisation">
          <option value="both" ${account.sync_direction === 'both' ? 'selected' : ''}>Deux sens</option>
          <option value="push" ${account.sync_direction === 'push' ? 'selected' : ''}>Envoyer seulement</option>
          <option value="pull" ${account.sync_direction === 'pull' ? 'selected' : ''}>Importer seulement</option>
        </select>
        <select data-role="member" aria-label="Membre associé">${memberOptions}</select>
        <button class="btn small ghost" data-role="pull" type="button">Importer</button>
        <button class="btn small danger" data-role="unlink" type="button">Délier</button>
      </div>`;

    card.querySelector('[data-role="enabled"]').addEventListener('change', (domEvent) =>
      patchAccount(account.id, { syncEnabled: domEvent.target.checked }),
    );
    card.querySelector('[data-role="direction"]').addEventListener('change', (domEvent) =>
      patchAccount(account.id, { syncDirection: domEvent.target.value }),
    );
    card.querySelector('[data-role="member"]').addEventListener('change', (domEvent) =>
      patchAccount(account.id, {
        memberId: domEvent.target.value ? Number(domEvent.target.value) : null,
      }),
    );
    card.querySelector('[data-role="pull"]').addEventListener('click', () => pullAccount(account.id));
    card.querySelector('[data-role="unlink"]').addEventListener('click', async () => {
      if (!confirm(`Délier ${account.account_email} ? Les dates déjà importées sont conservées.`)) return;
      await api(`/accounts/${account.id}`, { method: 'DELETE' });
      toast('Compte délié');
      await loadAll();
    });

    container.append(card);
  }

  for (const provider of state.providers) {
    const button = el(provider.id === 'google' ? 'btn-connect-google' : 'btn-connect-outlook');
    if (!button) continue;
    button.disabled = !provider.configured;
    button.title = provider.configured
      ? `Connecter un compte ${provider.label}`
      : `Identifiants OAuth ${provider.label} absents du fichier .env`;
  }
}

function renderReminderInfo() {
  const hour = String(state.settings.reminderHour).padStart(2, '0');
  const lines = [
    `<strong>Une semaine avant</strong> — à ${hour}h00, sept jours avant la date`,
    `<strong>La veille</strong> — à ${hour}h00, le jour précédent`,
    `<strong>Le jour J</strong> — à ${hour}h00 (ou une heure avant si l'événement est plus matinal)`,
    state.settings.emailEnabled
      ? `Envoi par <strong>e-mail</strong> aux membres concernés + fil de rappels`
      : `Envoi dans le <strong>fil de rappels</strong> (configurez SMTP_HOST pour les e-mails)`,
  ];
  el('reminder-info').innerHTML = lines
    .map((line) => `<li><span class="dot"></span><span>${line}</span></li>`)
    .join('');
}

function renderMembers() {
  const list = el('members-list');
  list.innerHTML = '';
  if (state.members.length === 0) {
    list.innerHTML = '<p class="empty">Ajoutez les membres du foyer pour cibler les rappels.</p>';
    return;
  }
  for (const member of state.members) {
    const item = document.createElement('li');
    item.innerHTML = `
      <span class="swatch" style="background:${escapeHtml(member.color)}"></span>
      <span>${escapeHtml(member.name)}</span>
      <span class="m-email">${escapeHtml(member.email || 'sans e-mail')}</span>
      <button class="btn small ghost" type="button">Retirer</button>`;
    item.querySelector('button').addEventListener('click', async () => {
      if (!confirm(`Retirer ${member.name} du foyer ?`)) return;
      await api(`/members/${member.id}`, { method: 'DELETE' });
      await loadAll();
    });
    list.append(item);
  }
}

function renderNotifications() {
  const unread = state.notifications.filter((item) => item.read_at === null).length;
  const badge = el('unread-badge');
  badge.textContent = String(unread);
  badge.hidden = unread === 0;

  const list = el('notifications-list');
  list.innerHTML = '';
  if (state.notifications.length === 0) {
    list.innerHTML = '<p class="empty">Aucun rappel envoyé pour l’instant.</p>';
    return;
  }
  for (const item of state.notifications) {
    const entry = document.createElement('li');
    if (item.read_at === null) entry.classList.add('unread');
    entry.innerHTML = `
      <div class="n-title">${escapeHtml(item.title)}</div>
      <div class="n-body">${escapeHtml(item.body)}</div>
      <div class="n-meta">${escapeHtml(item.created_at)}${item.offset_label ? ` · ${escapeHtml(item.offset_label)}` : ''}</div>`;
    if (item.read_at === null) {
      entry.addEventListener('click', async () => {
        await api(`/notifications/${item.id}/read`, { method: 'POST' });
        item.read_at = new Date().toISOString();
        renderNotifications();
      });
    }
    list.append(entry);
  }
}

// ─── Formulaire d'événement ──────────────────────────────────────────────────

const dialog = () => el('event-dialog');

function openEventDialog(event, dayKey) {
  const form = el('event-form');
  form.reset();
  el('event-error').hidden = true;
  el('event-dialog-title').textContent = event ? 'Modifier la date' : 'Nouvelle date';
  el('btn-delete-event').hidden = !event;

  // Propriétaire
  const owner = form.elements.ownerMemberId;
  owner.innerHTML = '<option value="">—</option>';
  for (const member of state.members) {
    const option = document.createElement('option');
    option.value = String(member.id);
    option.textContent = member.name;
    owner.append(option);
  }

  const participantIds = new Set((event?.participants ?? []).map((member) => member.id));
  el('participants-choices').innerHTML =
    state.members.length === 0
      ? '<p class="empty">Ajoutez d’abord des membres au foyer.</p>'
      : state.members
          .map(
            (member) => `
      <label class="choice">
        <input type="checkbox" name="participant" value="${member.id}" ${participantIds.has(member.id) ? 'checked' : ''} />
        <span class="swatch" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${escapeHtml(member.color)}"></span>
        <span>${escapeHtml(member.name)}</span>
      </label>`,
          )
          .join('');

  // Cibles de synchronisation : pré-cochées si l'événement y est déjà lié,
  // sinon tous les comptes actifs en écriture pour une nouvelle date.
  const linkedAccountIds = new Set((event?.links ?? []).map((link) => link.account_id));
  const pushable = state.accounts.filter(
    (account) => account.sync_enabled && ['push', 'both'].includes(account.sync_direction),
  );
  el('sync-choices-empty').hidden = pushable.length > 0;
  el('sync-choices').innerHTML = pushable
    .map((account) => {
      const checked = event ? linkedAccountIds.has(account.id) : true;
      const kindLabel = account.kind === 'pro' ? 'pro' : 'perso';
      return `
      <label class="choice">
        <input type="checkbox" name="syncAccount" value="${account.id}" ${checked ? 'checked' : ''} />
        <span class="tag ${account.provider}">${account.provider === 'google' ? 'Google' : 'Outlook'}</span>
        <span>${escapeHtml(account.account_email)} (${kindLabel})</span>
      </label>`;
    })
    .join('');

  const allDayInput = form.elements.allDay;
  if (event) {
    form.elements.id.value = String(event.id);
    form.elements.title.value = event.title;
    form.elements.description.value = event.description;
    form.elements.location.value = event.location;
    allDayInput.checked = event.all_day === 1;
    applyAllDayMode(allDayInput.checked);
    if (event.all_day === 1) {
      form.elements.startsAt.value = dateKey(event.starts_at);
      // La fin stockée est exclusive : on affiche le dernier jour inclus.
      form.elements.endsAt.value = dateKey(
        new Date(new Date(event.ends_at).getTime() - 60_000).toISOString(),
      );
    } else {
      form.elements.startsAt.value = toLocalInput(event.starts_at);
      form.elements.endsAt.value = toLocalInput(event.ends_at);
    }
    owner.value = event.owner_member_id ? String(event.owner_member_id) : '';
    renderReminderPreview(event);
  } else {
    form.elements.id.value = '';
    applyAllDayMode(false);
    const base = dayKey ?? todayKey();
    const hour = String(Math.max(state.settings.reminderHour, 9)).padStart(2, '0');
    form.elements.startsAt.value = `${base}T${hour}:00`;
    form.elements.endsAt.value = `${base}T${String(Number(hour) + 1).padStart(2, '0')}:00`;
    el('reminder-preview').hidden = true;
  }

  dialog().hidden = false;
  form.elements.title.focus();
}

/** Bascule les champs date/heure entre « journée entière » et horaire précis. */
function applyAllDayMode(allDay) {
  const form = el('event-form');
  for (const name of ['startsAt', 'endsAt']) {
    const input = form.elements[name];
    const previous = input.value;
    input.type = allDay ? 'date' : 'datetime-local';
    if (previous) {
      input.value = allDay
        ? previous.slice(0, 10)
        : previous.length === 10
          ? `${previous}T09:00`
          : previous;
    }
  }
}

function renderReminderPreview(event) {
  const box = el('reminder-preview');
  const labels = {
    week_before: 'Une semaine avant',
    day_before: 'La veille',
    same_day: 'Le jour J',
  };
  const statuses = {
    pending: 'programmé',
    sent: 'envoyé',
    skipped: 'ignoré (déjà passé)',
    failed: 'échec',
  };
  box.innerHTML = event.reminders
    .map(
      (reminder) => `
      <div class="r-line">
        <span class="r-key">${labels[reminder.offset_key] ?? reminder.offset_key}</span>
        <span>${escapeHtml(toLocalInput(reminder.scheduled_at).replace('T', ' à '))}</span>
        <span class="status ${reminder.status}">${statuses[reminder.status] ?? reminder.status}</span>
      </div>`,
    )
    .join('');
  box.hidden = event.reminders.length === 0;
}

function closeEventDialog() {
  dialog().hidden = true;
}

function collectEventForm() {
  const form = el('event-form');
  const allDay = form.elements.allDay.checked;
  const startsAt = form.elements.startsAt.value;
  let endsAt = form.elements.endsAt.value || undefined;
  // Les journées entières se saisissent en jours inclus ; l'API attend une fin exclusive.
  if (allDay && endsAt) endsAt = addDaysToKey(endsAt.slice(0, 10), 1);

  return {
    title: form.elements.title.value,
    description: form.elements.description.value,
    location: form.elements.location.value,
    allDay,
    startsAt,
    endsAt,
    timezone: state.timezone,
    ownerMemberId: form.elements.ownerMemberId.value
      ? Number(form.elements.ownerMemberId.value)
      : null,
    participantIds: [...form.querySelectorAll('input[name="participant"]:checked')].map((input) =>
      Number(input.value),
    ),
    syncAccountIds: [...form.querySelectorAll('input[name="syncAccount"]:checked')].map((input) =>
      Number(input.value),
    ),
  };
}

function reportSync(outcomes = []) {
  const failures = outcomes.filter((outcome) => outcome.status === 'error');
  const pushed = outcomes.filter((outcome) => ['created', 'updated'].includes(outcome.status));
  if (failures.length > 0) {
    toast(`Enregistré, mais synchro en échec : ${failures[0].error}`, 6000);
  } else if (pushed.length > 0) {
    toast(`Enregistré et synchronisé vers ${pushed.length} agenda(s)`);
  } else {
    toast('Enregistré');
  }
}

// ─── Comptes liés ────────────────────────────────────────────────────────────

async function patchAccount(id, settings) {
  try {
    await api(`/accounts/${id}`, { method: 'PATCH', body: settings });
    await loadAll();
  } catch (error) {
    toast(error.message, 5000);
  }
}

async function pullAccount(id) {
  const status = el('sync-status');
  status.textContent = 'Import en cours…';
  try {
    const { report } = await api(`/accounts/${id}/pull`, { method: 'POST' });
    status.textContent = report.error
      ? `⚠️ ${report.error}`
      : `Import terminé : ${report.created} ajoutée(s), ${report.updated} mise(s) à jour, ${report.deleted} supprimée(s).`;
    await loadAll();
  } catch (error) {
    status.textContent = `⚠️ ${error.message}`;
  }
}

function connect(provider, kind) {
  const memberId = state.memberFilter ? `&memberId=${state.memberFilter}` : '';
  const popup = window.open(
    `/api/oauth/${provider}/start?kind=${kind}${memberId}`,
    'familyboard-oauth',
    'width=520,height=680',
  );
  if (!popup) {
    window.location.href = `/api/oauth/${provider}/start?kind=${kind}${memberId}`;
  }
}

// ─── Divers ──────────────────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer;
function toast(message, duration = 3500) {
  const box = el('toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, duration);
}

function shiftMonth(delta) {
  const month = state.cursor.month + delta;
  state.cursor = {
    year: state.cursor.year + Math.floor((month - 1) / 12),
    month: ((month - 1 + 12) % 12) + 1,
  };
  void loadAll();
}

// ─── Câblage ─────────────────────────────────────────────────────────────────

function wire() {
  el('btn-prev').addEventListener('click', () => shiftMonth(-1));
  el('btn-next').addEventListener('click', () => shiftMonth(1));
  el('btn-today').addEventListener('click', () => {
    const key = todayKey();
    state.cursor = { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) };
    void loadAll();
  });

  el('member-filter').addEventListener('change', (domEvent) => {
    state.memberFilter = domEvent.target.value;
    void loadAll();
  });

  el('btn-new-event').addEventListener('click', () => openEventDialog(null));
  el('btn-close-dialog').addEventListener('click', closeEventDialog);
  el('btn-cancel-event').addEventListener('click', closeEventDialog);
  dialog().addEventListener('click', (domEvent) => {
    if (domEvent.target === dialog()) closeEventDialog();
  });
  document.addEventListener('keydown', (domEvent) => {
    if (domEvent.key === 'Escape') {
      closeEventDialog();
      el('notifications-panel').hidden = true;
    }
  });

  el('event-form').elements.allDay.addEventListener('change', (domEvent) =>
    applyAllDayMode(domEvent.target.checked),
  );

  el('event-form').addEventListener('submit', async (domEvent) => {
    domEvent.preventDefault();
    const errorBox = el('event-error');
    errorBox.hidden = true;
    const id = el('event-form').elements.id.value;
    const payload = collectEventForm();
    const saveButton = el('btn-save-event');
    saveButton.disabled = true;
    try {
      const result = id
        ? await api(`/events/${id}`, { method: 'PUT', body: payload })
        : await api('/events', { method: 'POST', body: payload });
      closeEventDialog();
      reportSync(result.sync);
      await loadAll();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    } finally {
      saveButton.disabled = false;
    }
  });

  el('btn-delete-event').addEventListener('click', async () => {
    const id = el('event-form').elements.id.value;
    if (!id || !confirm('Supprimer cette date ? Elle sera aussi retirée des agendas liés.')) return;
    await api(`/events/${id}`, { method: 'DELETE' });
    closeEventDialog();
    toast('Date supprimée');
    await loadAll();
  });

  el('btn-notifications').addEventListener('click', () => {
    const panel = el('notifications-panel');
    panel.hidden = !panel.hidden;
    el('btn-notifications').setAttribute('aria-expanded', String(!panel.hidden));
  });
  el('btn-close-notifications').addEventListener('click', () => {
    el('notifications-panel').hidden = true;
  });
  el('btn-read-all').addEventListener('click', async () => {
    await api('/notifications/read-all', {
      method: 'POST',
      body: state.memberFilter ? { memberId: Number(state.memberFilter) } : {},
    });
    await loadAll();
  });

  el('btn-connect-google').addEventListener('click', () => connect('google', 'personal'));
  el('btn-connect-outlook').addEventListener('click', () => connect('outlook', 'pro'));
  el('btn-pull-all').addEventListener('click', async () => {
    const status = el('sync-status');
    status.textContent = 'Import de tous les agendas…';
    try {
      const { reports } = await api('/accounts/pull-all', { method: 'POST' });
      const created = reports.reduce((total, item) => total + item.created, 0);
      const updated = reports.reduce((total, item) => total + item.updated, 0);
      const failed = reports.filter((item) => item.error);
      status.textContent = failed.length
        ? `⚠️ ${failed[0].provider} : ${failed[0].error}`
        : `${created} date(s) importée(s), ${updated} mise(s) à jour.`;
      await loadAll();
    } catch (error) {
      status.textContent = `⚠️ ${error.message}`;
    }
  });

  el('member-form').addEventListener('submit', async (domEvent) => {
    domEvent.preventDefault();
    const form = domEvent.target;
    try {
      await api('/members', {
        method: 'POST',
        body: {
          name: form.elements.name.value,
          color: form.elements.color.value,
          email: form.elements.email.value || null,
        },
      });
      form.reset();
      form.elements.color.value = '#4f7cff';
      await loadAll();
    } catch (error) {
      toast(error.message, 5000);
    }
  });

  // La popup OAuth prévient la page principale dès que le compte est relié.
  window.addEventListener('message', (domEvent) => {
    if (domEvent.data?.type === 'familyboard:oauth') {
      toast(domEvent.data.ok ? 'Compte relié' : 'Connexion refusée');
      void loadAll();
    }
  });
}

async function boot() {
  const key = new Intl.DateTimeFormat('sv-SE').format(new Date());
  state.cursor = { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) };
  wire();
  try {
    await loadAll();
  } catch (error) {
    toast(`Chargement impossible : ${error.message}`, 8000);
  }
  // Rafraîchissement discret pour voir arriver les rappels et les imports.
  setInterval(() => {
    if (dialog().hidden) void loadAll().catch(() => {});
  }, 60_000);
}

void boot();
