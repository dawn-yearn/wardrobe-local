export function buildOutfitPrompt({ top, bottom, regenerationPrompt = "" }) {
  const direction = regenerationPrompt
    ? `\nUser regeneration direction: ${regenerationPrompt}`
    : "";

  return `Use case: identity-preserve
Asset type: square full-body outfit preview

Image 1 is the identity reference for the exact person to preserve.
Image 2 is the exact top garment reference: ${top.name}.
Image 3 is the exact bottom garment reference: ${bottom.name}.

Create one photorealistic square editorial fashion photograph of the person from Image 1 wearing the exact top from Image 2 and the exact bottom from Image 3 at the same time.

Preserve the person's recognizable face, hair, age, build, skin texture, and body proportions. Preserve both garments precisely: their original colors, material, silhouette, fit, length, construction, patterns, graphics, logos, text, seams, proportions, and distinctive details. Do not merge the garments, exchange their colors, redesign them, or add another visible top or bottom.

Show the complete person from head through shoes. Use a relaxed mostly front-facing pose with arms away from the torso so both garments remain readable. Plain understated shoes and invisible basics such as socks are allowed only where needed. Use natural professional light, realistic anatomy and fabric, a restrained real-world setting, and authentic editorial photography.

Avoid cropped feet, crossed arms, hands covering garments, extra people, extra visible clothing, hats, bags, scarves, jewelry, text overlays, watermarks, product mockups, distorted anatomy, synthetic skin, invented garment details, and synthetic AI polish.${direction}`;
}
