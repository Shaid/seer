// lightbox.js — click-to-enlarge modal for gallery sprites/images (see
// Lightbox.astro's docblock for the full contract). Uses event delegation on
// `document`, so it works for elements added, shown, or hidden after
// initLightbox() runs (e.g. a SpriteGallery search filter toggling `hidden`)
// -- no per-gallery re-init needed. Any element anywhere on the page with a
// `data-lightbox` attribute becomes a trigger.
//
// Two kinds of trigger are auto-detected:
// - `<img data-lightbox>` -- enlarges that image's own `src`.
// - Any other element with `data-lightbox` and an inline CSS
//   `background-image`/`background-position`/`background-size` (the pattern
//   SpriteGallery uses to crop one frame from a shared atlas) -- enlarges
//   that exact crop, scaled up, rather than the whole underlying atlas.
// Optional `data-lightbox-label` (or a plain `aria-label`) sets a caption.

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const MAX_WIDTH_FRACTION = 0.85;
const MAX_HEIGHT_FRACTION = 0.75;

function parsePair(value) {
	const [a, b] = (value || '0px 0px').split(' ').map((v) => parseFloat(v) || 0);
	return [a, b];
}

function computeScale(w, h) {
	const maxW = window.innerWidth * MAX_WIDTH_FRACTION;
	const maxH = window.innerHeight * MAX_HEIGHT_FRACTION;
	return Math.max(MIN_SCALE, Math.min(MAX_SCALE, maxW / w, maxH / h));
}

function openImageTrigger(trigger, els) {
	els.image.hidden = false;
	els.crop.hidden = true;
	els.image.src = trigger.currentSrc || trigger.src;
	els.image.style.width = '';
	els.image.style.height = '';
	els.image.onload = () => {
		const scale = computeScale(els.image.naturalWidth, els.image.naturalHeight);
		els.image.style.width = `${Math.round(els.image.naturalWidth * scale)}px`;
		els.image.style.height = `${Math.round(els.image.naturalHeight * scale)}px`;
	};
}

function openBackgroundTrigger(trigger, els) {
	const curW = trigger.offsetWidth || 1;
	const curH = trigger.offsetHeight || 1;
	const scale = computeScale(curW, curH);
	const [sizeW, sizeH] = parsePair(trigger.style.backgroundSize);
	const [posX, posY] = parsePair(trigger.style.backgroundPosition);

	els.image.hidden = true;
	els.crop.hidden = false;
	els.crop.style.backgroundImage = trigger.style.backgroundImage;
	els.crop.style.backgroundRepeat = 'no-repeat';
	els.crop.style.width = `${Math.round(curW * scale)}px`;
	els.crop.style.height = `${Math.round(curH * scale)}px`;
	els.crop.style.backgroundSize = `${Math.round(sizeW * scale)}px ${Math.round(sizeH * scale)}px`;
	els.crop.style.backgroundPosition = `${Math.round(posX * scale)}px ${Math.round(posY * scale)}px`;
}

function open(trigger) {
	const overlay = document.getElementById('lightbox-overlay');
	if (!overlay) return;
	const els = {
		image: overlay.querySelector('.lightbox-image'),
		crop: overlay.querySelector('.lightbox-crop'),
		caption: overlay.querySelector('.lightbox-caption'),
	};
	if (!els.image || !els.crop || !els.caption) return;

	if (trigger.tagName === 'IMG') {
		openImageTrigger(trigger, els);
	} else if (trigger.style.backgroundImage) {
		openBackgroundTrigger(trigger, els);
	} else {
		return;
	}

	els.caption.textContent = trigger.dataset.lightboxLabel ?? trigger.getAttribute('aria-label') ?? '';
	overlay.classList.add('lightbox-open');
}

function close() {
	document.getElementById('lightbox-overlay')?.classList.remove('lightbox-open');
}

let delegated = false;

export function initLightbox() {
	const overlay = document.getElementById('lightbox-overlay');
	if (!overlay) return;

	if (!overlay.dataset.lightboxWired) {
		overlay.dataset.lightboxWired = '1';
		overlay.querySelector('.lightbox-close')?.addEventListener('click', close);
		overlay.addEventListener('click', (event) => {
			if (event.target === overlay) close();
		});
	}

	if (delegated) return;
	delegated = true;
	document.addEventListener('click', (event) => {
		const trigger = event.target.closest('[data-lightbox]');
		if (trigger) open(trigger);
	});
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') close();
	});
}
