import { Router } from 'express';
import { getDb } from '../db/index.ts';
import {
  createEvent,
  deleteEvent,
  eventInputSchema,
  getEventDetail,
  listEvents,
  updateEvent,
  EventValidationError,
} from '../domain/events.ts';
import { deleteRemoteCopies, pushEvent } from '../domain/sync.ts';

export const eventsRouter: Router = Router();

eventsRouter.get('/', (req, res) => {
  const { from, to, memberId } = req.query;
  const events = listEvents(getDb(), {
    from: typeof from === 'string' ? from : undefined,
    to: typeof to === 'string' ? to : undefined,
    memberId: typeof memberId === 'string' && memberId ? Number(memberId) : undefined,
  });
  res.json({ events });
});

eventsRouter.get('/:id', (req, res) => {
  const event = getEventDetail(getDb(), Number(req.params.id));
  if (!event) {
    res.status(404).json({ error: 'Événement introuvable' });
    return;
  }
  res.json({ event });
});

eventsRouter.post('/', async (req, res, next) => {
  const parsed = eventInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Données invalides', details: parsed.error.issues });
    return;
  }
  try {
    const event = createEvent(getDb(), parsed.data);
    // La synchronisation ne doit pas faire échouer la création locale.
    const sync = await pushEvent(getDb(), event.id, parsed.data.syncAccountIds);
    res.status(201).json({ event: getEventDetail(getDb(), event.id), sync });
  } catch (error) {
    if (error instanceof EventValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

eventsRouter.put('/:id', async (req, res, next) => {
  const parsed = eventInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Données invalides', details: parsed.error.issues });
    return;
  }
  try {
    const id = Number(req.params.id);
    const event = updateEvent(getDb(), id, parsed.data);
    if (!event) {
      res.status(404).json({ error: 'Événement introuvable' });
      return;
    }
    const sync = await pushEvent(getDb(), id, parsed.data.syncAccountIds);
    res.json({ event: getEventDetail(getDb(), id), sync });
  } catch (error) {
    if (error instanceof EventValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

eventsRouter.post('/:id/push', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!getEventDetail(getDb(), id)) {
      res.status(404).json({ error: 'Événement introuvable' });
      return;
    }
    const accountIds = Array.isArray(req.body?.accountIds)
      ? req.body.accountIds.map(Number).filter(Number.isFinite)
      : undefined;
    res.json({ sync: await pushEvent(getDb(), id, accountIds) });
  } catch (error) {
    next(error);
  }
});

eventsRouter.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!getEventDetail(getDb(), id)) {
      res.status(404).json({ error: 'Événement introuvable' });
      return;
    }
    // Les copies distantes partent d'abord : après suppression locale, les liens sont perdus.
    await deleteRemoteCopies(getDb(), id);
    deleteEvent(getDb(), id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
