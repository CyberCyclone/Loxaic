import { describe, expect, it } from 'vitest';
import { imageSwitchState, type ImageSwitchInput } from './imageSwitch';

const base: ImageSwitchInput = {
  saved: true, isOwner: true, workspaceKind: 'scratch', hasImage: false,
  policy: 'shared', blocked: undefined, running: false, reachable: true,
};

describe('imageSwitchState', () => {
  it("offers it to the owner of a saved server workspace while there is an image to choose", () => {
    expect(imageSwitchState(base)).toEqual({ offered: true, disabledReason: null });
  });

  it('never offers it to anyone else, before the conversation exists, or for a local folder', () => {
    expect(imageSwitchState({ ...base, isOwner: false }).offered).toBe(false);
    expect(imageSwitchState({ ...base, saved: false }).offered).toBe(false);
    expect(imageSwitchState({ ...base, workspaceKind: 'local' }).offered).toBe(false);
  });

  it("offers a way back to Loxaic's image even once custom images are off or blocked", () => {
    expect(imageSwitchState({ ...base, policy: 'off' }).offered).toBe(false);
    expect(imageSwitchState({ ...base, policy: 'off', hasImage: true }).offered).toBe(true);
    expect(imageSwitchState({ ...base, blocked: 'needs Docker' }).offered).toBe(false);
    expect(imageSwitchState({ ...base, policy: undefined }).offered).toBe(false);
  });

  it('disables it while a run is going, and while the server is unreachable, saying which', () => {
    expect(imageSwitchState({ ...base, running: true }).disabledReason).toMatch(/Stop the run first/);
    expect(imageSwitchState({ ...base, reachable: false }).disabledReason).toMatch(/reach your server/);
  });
});
