import { GameState, Card, Player } from '../types';

const MASK_CARD: Card = {
  suit: '♠',
  rank: '?',
  value: 0,
};

function cloneState(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

function sanitizePlayerMeta(player: Player): Player {
  return {
    ...player,
    botToken: undefined,
    botId: undefined,
    apiUrl: undefined,
    sessionId: undefined,
  };
}

function shouldRevealCards(state: GameState, player: Player, viewerPlayerId?: string): boolean {
  if (viewerPlayerId && player.id === viewerPlayerId) return true;
  if (!state.showdownRevealed) return false;
  return !player.isFolded;
}

export function projectGameStateForViewer(
  state: GameState,
  viewerPlayerId?: string,
): GameState {
  const projected = cloneState(state);

  projected.players = projected.players.map((player) => {
    const revealCards = shouldRevealCards(projected, player, viewerPlayerId);
    const visibleCards = revealCards
      ? player.cards
      : player.cards.map(() => ({ ...MASK_CARD }));

    return sanitizePlayerMeta({
      ...player,
      cards: visibleCards,
    });
  });

  if (!projected.showdownRevealed && projected.handSummary) {
    if (viewerPlayerId && projected.handSummary[viewerPlayerId]) {
      projected.handSummary = {
        [viewerPlayerId]: projected.handSummary[viewerPlayerId],
      };
    } else {
      projected.handSummary = undefined;
    }
  }

  return projected;
}
