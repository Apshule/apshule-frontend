ALTER TABLE lab_experiments
  ADD COLUMN IF NOT EXISTS embed_provider TEXT DEFAULT 'custom',
  ADD COLUMN IF NOT EXISTS embed_url TEXT,
  ADD COLUMN IF NOT EXISTS fallback_url TEXT,
  ADD COLUMN IF NOT EXISTS embed_height INT DEFAULT 550;

UPDATE lab_experiments SET embed_provider = 'phet',
  embed_url = 'https://phet.colorado.edu/sims/html/natural-selection/latest/natural-selection_en.html',
  fallback_url = 'https://phet.colorado.edu/sims/html/natural-selection/latest/natural-selection_en.html'
  WHERE code IN ('PRIM_PLANTS', 'AL_GENETICS');
UPDATE lab_experiments SET embed_provider = 'phet',
  embed_url = 'https://phet.colorado.edu/sims/html/states-of-matter-basics/latest/states-of-matter-basics_en.html',
  fallback_url = 'https://phet.colorado.edu/sims/html/states-of-matter-basics/latest/states-of-matter-basics_en.html'
  WHERE code = 'PRIM_WATER';
UPDATE lab_experiments SET embed_provider = 'phet',
  embed_url = 'https://phet.colorado.edu/sims/html/magnets-and-electromagnets/latest/magnets-and-electromagnets_en.html',
  fallback_url = 'https://phet.colorado.edu/sims/html/magnets-and-electromagnets/latest/magnets-and-electromagnets_en.html'
  WHERE code IN ('PRIM_MAGNETS', 'OL_FIELDS');
UPDATE lab_experiments SET embed_provider = 'phet',
  embed_url = 'https://phet.colorado.edu/sims/html/wave-on-a-string/latest/wave-on-a-string_en.html',
  fallback_url = 'https://phet.colorado.edu/sims/html/wave-on-a-string/latest/wave-on-a-string_en.html'
  WHERE code = 'PRIM_SOUND';
UPDATE lab_experiments SET embed_provider = 'phet',
  embed_url = 'https://phet.colorado.edu/sims/html/circuit-construction-kit-dc/latest/circuit-construction-kit-dc_en.html',
  fallback_url = 'https://phet.colorado.edu/sims/html/circuit-construction-kit-dc/latest/circuit-construction-kit-dc_en.html'
  WHERE code = 'OL_CIRCUIT';
UPDATE lab_experiments SET embed_provider = 'phet',
  embed_url = 'https://phet.colorado.edu/sims/html/ph-scale/latest/ph-scale_en.html',
  fallback_url = 'https://phet.colorado.edu/sims/html/ph-scale/latest/ph-scale_en.html'
  WHERE code = 'OL_TITRATE';
UPDATE lab_experiments SET embed_provider = 'phet',
  embed_url = 'https://phet.colorado.edu/sims/html/balancing-act/latest/balancing-act_en.html',
  fallback_url = 'https://phet.colorado.edu/sims/html/balancing-act/latest/balancing-act_en.html'
  WHERE code = 'OL_LEVER';
UPDATE lab_experiments SET embed_provider = 'phet',
  embed_url = 'https://phet.colorado.edu/sims/html/greenhouse-effect/latest/greenhouse-effect_en.html',
  fallback_url = 'https://phet.colorado.edu/sims/html/greenhouse-effect/latest/greenhouse-effect_en.html'
  WHERE code = 'OL_PHOTOSYN';
UPDATE lab_experiments SET embed_provider = 'phet',
  embed_url = 'https://phet.colorado.edu/sims/html/projectile-motion/latest/projectile-motion_en.html',
  fallback_url = 'https://phet.colorado.edu/sims/html/projectile-motion/latest/projectile-motion_en.html'
  WHERE code = 'AL_PROJECTILE';
UPDATE lab_experiments SET embed_provider = 'phet',
  embed_url = 'https://phet.colorado.edu/sims/html/reactants-products-and-leftovers/latest/reactants-products-and-leftovers_en.html',
  fallback_url = 'https://phet.colorado.edu/sims/html/reactants-products-and-leftovers/latest/reactants-products-and-leftovers_en.html'
  WHERE code = 'AL_REACTION';

INSERT INTO lab_experiments
  (code, title, subject, level, description, simulator_type, embed_provider, embed_url, fallback_url, embed_height, display_order)
VALUES
  ('OL_FORCES', 'Forces and Motion', 'Physics', 'o_level', 'Explore forces, motion, and friction.', 'phet', 'phet', 'https://phet.colorado.edu/sims/html/forces-and-motion-basics/latest/forces-and-motion-basics_en.html', 'https://phet.colorado.edu/sims/html/forces-and-motion-basics/latest/forces-and-motion-basics_en.html', 600, 30),
  ('OL_WAVES', 'Wave Interference', 'Physics', 'o_level', 'See how waves combine and cancel.', 'phet', 'phet', 'https://phet.colorado.edu/sims/html/wave-interference/latest/wave-interference_en.html', 'https://phet.colorado.edu/sims/html/wave-interference/latest/wave-interference_en.html', 600, 31),
  ('OL_PH_SCALE', 'pH Scale', 'Chemistry', 'o_level', 'Test the pH of everyday liquids.', 'phet', 'phet', 'https://phet.colorado.edu/sims/html/ph-scale/latest/ph-scale_en.html', 'https://phet.colorado.edu/sims/html/ph-scale/latest/ph-scale_en.html', 600, 32),
  ('OL_MOLECULES', 'Build a Molecule', 'Chemistry', 'o_level', 'Build molecules from atoms.', 'phet', 'phet', 'https://phet.colorado.edu/sims/html/build-a-molecule/latest/build-a-molecule_en.html', 'https://phet.colorado.edu/sims/html/build-a-molecule/latest/build-a-molecule_en.html', 600, 33),
  ('PRIM_FRACTIONS', 'Fractions Intro', 'Mathematics', 'primary', 'Match shapes to fractions.', 'phet', 'phet', 'https://phet.colorado.edu/sims/html/fractions-intro/latest/fractions-intro_en.html', 'https://phet.colorado.edu/sims/html/fractions-intro/latest/fractions-intro_en.html', 600, 34),
  ('PRIM_GRAPHING', 'Graphing Lines', 'Mathematics', 'primary', 'Explore slope and intercept.', 'phet', 'phet', 'https://phet.colorado.edu/sims/html/graphing-lines/latest/graphing-lines_en.html', 'https://phet.colorado.edu/sims/html/graphing-lines/latest/graphing-lines_en.html', 600, 35),
  ('PRIM_AREA', 'Area Builder', 'Mathematics', 'primary', 'Build shapes and compare their areas.', 'phet', 'phet', 'https://phet.colorado.edu/sims/html/area-builder/latest/area-builder_en.html', 'https://phet.colorado.edu/sims/html/area-builder/latest/area-builder_en.html', 600, 36),
  ('PRIM_RATIO', 'Ratio and Proportion', 'Mathematics', 'primary', 'Explore equivalent ratios visually.', 'phet', 'phet', 'https://phet.colorado.edu/sims/html/ratio-and-proportion/latest/ratio-and-proportion_en.html', 'https://phet.colorado.edu/sims/html/ratio-and-proportion/latest/ratio-and-proportion_en.html', 600, 37),
  ('PRIM_ENERGY', 'Energy Skate Park', 'Science', 'primary', 'Explore energy and motion on a track.', 'phet', 'phet', 'https://phet.colorado.edu/sims/html/energy-skate-park-basics/latest/energy-skate-park-basics_en.html', 'https://phet.colorado.edu/sims/html/energy-skate-park-basics/latest/energy-skate-park-basics_en.html', 600, 38),
  ('OL_GEOMETRY', 'Geometry Construction', 'Mathematics', 'o_level', 'Explore geometry with an interactive construction.', 'geogebra', 'geogebra', 'https://www.geogebra.org/geometry', 'https://www.geogebra.org/geometry', 600, 39),
  ('OL_REFRACTION', 'Bending Light', 'Physics', 'o_level', 'Explore how light bends as it passes between materials.', 'phet', 'phet', 'https://phet.colorado.edu/sims/html/bending-light/latest/bending-light_en.html', 'https://phet.colorado.edu/sims/html/bending-light/latest/bending-light_en.html', 600, 40),
  ('PRIM_MANIPULATIVES', 'Mathigon Polypad', 'Mathematics', 'primary', 'Virtual manipulatives for fractions, algebra, and geometry.', 'mathigon', 'mathigon', 'https://mathigon.org/polypad/embed/GD2q2m3z', 'https://mathigon.org/polypad/embed/GD2q2m3z', 650, 40),
  ('AL_CIRCUITS', 'Falstad Circuit Simulator', 'Physics', 'a_level', 'Build and inspect advanced circuits.', 'falstad', 'falstad', 'https://www.falstad.com/circuit/circuitjs.html', 'https://www.falstad.com/circuit/circuitjs.html', 650, 41),
  ('OL_LIGHT', 'Geometric Optics', 'Physics', 'o_level', 'Trace rays through lenses and mirrors.', 'phet', 'phet', 'https://phet.colorado.edu/sims/html/geometric-optics/latest/geometric-optics_en.html', 'https://phet.colorado.edu/sims/html/geometric-optics/latest/geometric-optics_en.html', 600, 42),
  ('OL_DENSITY', 'Density', 'Physics', 'o_level', 'Compare mass and volume to understand density.', 'phet', 'phet', 'https://phet.colorado.edu/sims/html/density/latest/density_en.html', 'https://phet.colorado.edu/sims/html/density/latest/density_en.html', 600, 43),
  ('OL_GAS', 'Gas Properties', 'Chemistry', 'o_level', 'Investigate pressure, volume, and temperature.', 'phet', 'phet', 'https://phet.colorado.edu/sims/html/gas-properties/latest/gas-properties_en.html', 'https://phet.colorado.edu/sims/html/gas-properties/latest/gas-properties_en.html', 600, 44),
  ('AL_GRAVITY', 'Gravity and Orbits', 'Physics', 'a_level', 'Explore gravitational attraction and orbits.', 'phet', 'phet', 'https://phet.colorado.edu/sims/html/gravity-and-orbits/latest/gravity-and-orbits_en.html', 'https://phet.colorado.edu/sims/html/gravity-and-orbits/latest/gravity-and-orbits_en.html', 600, 45),
  ('AL_ATOMS', 'Molecule Shapes', 'Chemistry', 'a_level', 'Explore molecular geometry and bonding.', 'phet', 'phet', 'https://phet.colorado.edu/sims/html/molecule-shapes/latest/molecule-shapes_en.html', 'https://phet.colorado.edu/sims/html/molecule-shapes/latest/molecule-shapes_en.html', 600, 46),
  ('AL_ELECTRIC', 'Charges and Fields', 'Physics', 'a_level', 'Place charges and inspect electric fields.', 'phet', 'phet', 'https://phet.colorado.edu/sims/html/charges-and-fields/latest/charges-and-fields_en.html', 'https://phet.colorado.edu/sims/html/charges-and-fields/latest/charges-and-fields_en.html', 600, 47),
  ('PRIM_SOUND_WAVES', 'Wave on a String', 'Science', 'primary', 'Change frequency and amplitude to explore waves.', 'phet', 'phet', 'https://phet.colorado.edu/sims/html/wave-on-a-string/latest/wave-on-a-string_en.html', 'https://phet.colorado.edu/sims/html/wave-on-a-string/latest/wave-on-a-string_en.html', 600, 48),
  ('OL_ENERGY', 'Energy Forms and Changes', 'Physics', 'o_level', 'Track energy as it changes form.', 'phet', 'phet', 'https://phet.colorado.edu/sims/html/energy-forms-and-changes/latest/energy-forms-and-changes_en.html', 'https://phet.colorado.edu/sims/html/energy-forms-and-changes/latest/energy-forms-and-changes_en.html', 600, 49)
ON CONFLICT (code) DO UPDATE SET
  embed_provider = EXCLUDED.embed_provider,
  embed_url = EXCLUDED.embed_url,
  fallback_url = EXCLUDED.fallback_url,
  embed_height = EXCLUDED.embed_height,
  simulator_type = EXCLUDED.simulator_type;
