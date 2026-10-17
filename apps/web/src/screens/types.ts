import type { MemberId } from '@kitty/shared';
import type { Screen } from '../nav.js';
import type { TripState } from '../state.js';

export interface ScreenProps {
  as: MemberId;
  trip: TripState;
  go: (screen: Screen) => void;
}
