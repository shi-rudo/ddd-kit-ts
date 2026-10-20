const COUNTER_LIMIT = 2 ** 42;

let lastMilliseconds = Number.NEGATIVE_INFINITY;
let counter = 0;

/**
 * RFC 9562 UUID version 7: the Unix time in milliseconds in the first 48 bits,
 * then random bits from Web Crypto. A B-tree index on such ids stays
 * clustered.
 *
 * The ids of one process sort in creation order. Ids from several processes
 * interleave within one millisecond and depend on their clocks. Within one
 * millisecond of one process, a 42-bit counter increases by one per id: the
 * 12 bits of `rand_a` and the first 30 bits of `rand_b`. It starts at a random
 * value with its top bit clear, so it does not run out in practice, also not
 * on a runtime that stops the clock during a request. If it runs out, the time
 * field moves one millisecond ahead. A clock that goes back does not move the
 * time field back. This is method 1 of RFC 9562, section 6.2.
 */
export function uuidV7(): string {
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	const view = new DataView(bytes.buffer);
	// The time field below overwrites bytes 0 to 5, so their random bits
	// seed the counter without taking bits from the rest of the id.
	const seed = (view.getUint16(0) & 0x01ff) * 2 ** 32 + view.getUint32(2);
	const now = Date.now();
	if (now > lastMilliseconds) {
		lastMilliseconds = now;
		counter = seed;
	} else if (counter + 1 < COUNTER_LIMIT) {
		counter += 1;
	} else {
		lastMilliseconds += 1;
		counter = seed;
	}

	// Bit operators work on 32 bits, and the time needs 48.
	let time = lastMilliseconds;
	for (let index = 5; index >= 0; index -= 1) {
		bytes[index] = time % 0x100;
		time = Math.floor(time / 0x100);
	}
	const counterHigh = Math.floor(counter / 2 ** 24);
	const counterLow = counter % 2 ** 24;
	view.setUint16(6, 0x7000 | (counterHigh >>> 6));
	view.setUint8(8, 0x80 | (counterHigh & 0x3f));
	view.setUint8(9, counterLow >>> 16);
	view.setUint16(10, counterLow & 0xffff);

	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
