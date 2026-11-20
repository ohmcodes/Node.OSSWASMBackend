import { randomInt } from "node:crypto";

const ADJECTIVES = [
  "Brave", "Swift", "Lucky", "Clever", "Mighty", "Silent", "Happy", "Bold", "Calm", "Fierce",
  "Gentle", "Jolly", "Nimble", "Quick", "Sly", "Sunny", "Wild", "Witty", "Cosmic", "Frosty",
  "Golden", "Iron", "Mystic", "Neon", "Rapid", "Shadow", "Stormy", "Turbo", "Velvet", "Zesty",
];

const ANIMALS = [
  "Fox", "Otter", "Panda", "Tiger", "Falcon", "Wolf", "Koala", "Lynx", "Raven", "Badger",
  "Gecko", "Moose", "Owl", "Shark", "Yak", "Bison", "Cobra", "Dingo", "Ferret", "Heron",
  "Ibex", "Jaguar", "Lemur", "Marten", "Newt", "Puffin", "Quokka", "Salmon", "Toucan", "Walrus",
];

/** A friendly random guest name like "SwiftOtter4821" (30 x 30 x 9000 = 8.1 million combinations). */
export function randomGuestName(): string {
  return `${ADJECTIVES[randomInt(ADJECTIVES.length)]}${ANIMALS[randomInt(ANIMALS.length)]}${randomInt(1000, 10000)}`;
}

export const MAX_DISPLAY_NAME = 24;

/**
 * Cleans a player-chosen display name: removes control characters and < > (names are shown in web pages and UMG),
 * collapses whitespace, trims, and caps the length. Returns "" if nothing usable is left.
 */
export function sanitizeDisplayName(name: string): string {
  return name
    .replace(/[\p{Cc}\p{Cf}<>]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DISPLAY_NAME)
    .trim();
}
