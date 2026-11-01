/**
 * CBSE Class 11–12 Science + Mathematics curriculum seed.
 * Source: CBSE Academic Curriculum 2025–26 SrSec PDFs
 *   https://cbseacademic.nic.in/curriculum_2026.html
 *   Physics_SrSec_2025-26.pdf / Chemistry_SrSec_2025-26.pdf
 *   Maths_SrSec_2025-26.pdf / Biology_SrSec_2025-26.pdf
 *
 * subTopics include official sub-concepts plus live free-text aliases
 * from PartnerB / PartnerE / Partner Academy A exam rubrics.
 */

function entry(board, grade, subject, subjectSlug, slug, topic, subTopics, difficultyWeight = 0.55) {
  const boardKey = String(board).toLowerCase();
  const gradeKey = String(grade).replace(/[^0-9]/g, '');
  return {
    id: `${boardKey}_${gradeKey}_${subjectSlug}_${slug}`,
    board,
    grade,
    subject,
    topic,
    subTopics,
    difficultyWeight,
  };
}

const chem = (grade, slug, topic, subTopics, w) => entry('CBSE', grade, 'Chemistry', 'chem', slug, topic, subTopics, w);
const phys = (grade, slug, topic, subTopics, w) => entry('CBSE', grade, 'Physics', 'phys', slug, topic, subTopics, w);
const math = (grade, slug, topic, subTopics, w) => entry('CBSE', grade, 'Mathematics', 'math', slug, topic, subTopics, w);
const bio = (grade, slug, topic, subTopics, w) => entry('CBSE', grade, 'Biology', 'bio', slug, topic, subTopics, w);

/* ── Chemistry XI (Code 043) ── */
const CBSE_11_CHEM = [
  chem('11th', 'basic_concepts', 'Some Basic Concepts of Chemistry', [
    'mole concept', 'molar mass', 'stoichiometry', 'empirical formula', 'molecular formula',
    'percentage composition', 'laws of chemical combination', 'dalton atomic theory',
  ], 0.55),
  chem('11th', 'structure_atom', 'Structure of Atom', [
    'bohr model', 'quantum numbers', 'orbitals', 'aufbau', 'pauli', 'hund', 'electronic configuration',
  ], 0.6),
  chem('11th', 'periodicity', 'Classification of Elements and Periodicity in Properties', [
    'periodic table', 'periodic trends', 'ionization enthalpy', 'electronegativity', 'atomic radii',
  ], 0.55),
  chem('11th', 'bonding', 'Chemical Bonding and Molecular Structure', [
    'VSEPR', 'hybridization', 'lewis structure', 'molecular orbital', 'hydrogen bond', 'ionic bond', 'covalent bond',
  ], 0.65),
  chem('11th', 'thermodynamics', 'Chemical Thermodynamics', [
    'enthalpy', 'entropy', 'gibbs energy', 'hess law', 'first law', 'second law',
  ], 0.65),
  chem('11th', 'equilibrium', 'Equilibrium', [
    'le chatelier', 'equilibrium constant', 'pH', 'buffer', 'solubility product', 'common ion effect', 'henderson',
  ], 0.65),
  chem('11th', 'redox', 'Redox Reactions', [
    'oxidation number', 'balancing redox', 'oxidation', 'reduction',
  ], 0.5),
  chem('11th', 'organic_basics', 'Organic Chemistry: Some Basic Principles and Techniques', [
    'IUPAC nomenclature', 'inductive effect', 'resonance', 'hyperconjugation', 'electrophile', 'nucleophile',
    'carbocation', 'free radical',
  ], 0.6),
  chem('11th', 'hydrocarbons', 'Hydrocarbons', [
    'alkanes', 'alkenes', 'alkynes', 'benzene', 'markovnikov', 'electrophilic substitution', 'aromaticity',
  ], 0.6),
];

/* ── Chemistry XII (Code 043) ── */
const CBSE_12_CHEM = [
  chem('12th', 'solutions', 'Solutions', [
    'raoult law', "raoult's law", 'colligative properties', "van't hoff factor", 'vant hoff',
    'osmotic pressure', 'elevation of boiling point', 'depression of freezing point',
    'concentration terms', 'molality', 'molarity', 'mole fraction', "henry's law", 'henry law',
    'ideal solutions', 'abnormal molecular mass', 'freezing point depression',
  ], 0.6),
  chem('12th', 'electrochemistry', 'Electrochemistry', [
    'nernst equation', 'galvanic cell', 'electrolysis', 'conductivity', 'kohlrausch', 'fuel cell', 'emf',
  ], 0.65),
  chem('12th', 'kinetics', 'Chemical Kinetics', [
    'rate law', 'order of reaction', 'half life', 'arrhenius', 'activation energy', 'collision theory',
  ], 0.65),
  chem('12th', 'd_f_block', 'd-and f-Block Elements', [
    'transition metals', 'lanthanides', 'actinides', 'KMnO4', 'K2Cr2O7', 'lanthanide contraction',
  ], 0.6),
  chem('12th', 'coordination', 'Coordination Compounds', [
    'ligands', 'werner theory', 'CFT', 'VBT', 'IUPAC nomenclature', 'coordination number',
  ], 0.65),
  chem('12th', 'haloalkanes', 'Haloalkanes and Haloarenes', [
    'SN1', 'SN2', 'optical rotation', 'haloarenes', 'freons', 'DDT',
  ], 0.6),
  chem('12th', 'alcohols_phenols_ethers', 'Alcohols, Phenols and Ethers', [
    'dehydration', 'phenol acidity', 'ethers', 'primary alcohol',
  ], 0.6),
  chem('12th', 'carbonyls', 'Aldehydes, Ketones and Carboxylic Acids', [
    'nucleophilic addition', 'carbonyl', 'carboxylic acids', 'aldehyde', 'ketone',
  ], 0.65),
  chem('12th', 'amines', 'Amines', [
    'diazonium salts', 'primary amine', 'basicity of amines',
  ], 0.55),
  chem('12th', 'biomolecules', 'Biomolecules', [
    'carbohydrates', 'proteins', 'vitamins', 'nucleic acids', 'enzymes', 'amino acids',
  ], 0.55),
];

/* ── Physics XI (Code 042) ── */
const CBSE_11_PHYS = [
  phys('11th', 'units_measurements', 'Units and Measurements', [
    'SI units', 'significant figures', 'dimensional analysis', 'uncertainty',
  ], 0.45),
  phys('11th', 'motion_straight', 'Motion in a Straight Line', [
    'velocity', 'acceleration', 'kinematic equations', 'graphs',
  ], 0.5),
  phys('11th', 'motion_plane', 'Motion in a Plane', [
    'vectors', 'projectile motion', 'uniform circular motion', 'scalar product', 'vector product',
  ], 0.55),
  phys('11th', 'laws_motion', 'Laws of Motion', [
    'newton laws', 'friction', 'centripetal force', 'momentum', 'impulse',
  ], 0.55),
  phys('11th', 'work_energy_power', 'Work, Energy and Power', [
    'work energy theorem', 'potential energy', 'collisions', 'power', 'conservative forces',
  ], 0.55),
  phys('11th', 'rotational', 'System of Particles and Rotational Motion', [
    'centre of mass', 'torque', 'angular momentum', 'moment of inertia',
  ], 0.65),
  phys('11th', 'gravitation', 'Gravitation', [
    'kepler', 'escape speed', 'orbital velocity', 'gravitational potential',
  ], 0.55),
  phys('11th', 'solids', 'Mechanical Properties of Solids', [
    'elasticity', 'young modulus', 'hooke law', 'stress strain',
  ], 0.5),
  phys('11th', 'fluids', 'Mechanical Properties of Fluids', [
    'bernoulli', 'viscosity', 'surface tension', 'stokes law', 'pascal law',
  ], 0.55),
  phys('11th', 'thermal', 'Thermal Properties of Matter', [
    'specific heat', 'latent heat', 'thermal expansion', 'conduction', 'stefan law',
  ], 0.5),
  phys('11th', 'thermodynamics', 'Thermodynamics', [
    'first law', 'second law', 'isothermal', 'adiabatic', 'heat engine',
  ], 0.6),
  phys('11th', 'kinetic_theory', 'Kinetic Theory', [
    'ideal gas', 'rms speed', 'mean free path', 'degrees of freedom',
  ], 0.55),
  phys('11th', 'oscillations', 'Oscillations', [
    'SHM', 'simple pendulum', 'spring', 'periodic motion',
  ], 0.55),
  phys('11th', 'waves', 'Waves', [
    'standing waves', 'beats', 'superposition', 'organ pipes', 'transverse', 'longitudinal',
  ], 0.55),
];

/* ── Physics XII (Code 042) ── */
const CBSE_12_PHYS = [
  phys('12th', 'charges_fields', 'Electric Charges and Fields', [
    'coulomb law', 'electric field', 'gauss law', 'dipole', 'electrostatics',
  ], 0.6),
  phys('12th', 'potential_capacitance', 'Electrostatic Potential and Capacitance', [
    'potential', 'capacitance', 'dielectric', 'capacitors', 'electrostatics',
  ], 0.6),
  phys('12th', 'current', 'Current Electricity', [
    'ohm law', 'kirchhoff', 'resistivity', 'wheatstone', 'cells',
  ], 0.55),
  phys('12th', 'moving_charges', 'Moving Charges and Magnetism', [
    'biot savart', 'ampere law', 'lorentz force', 'cyclotron', 'magnetic field',
  ], 0.6),
  phys('12th', 'magnetism_matter', 'Magnetism and Matter', [
    'bar magnet', 'earth magnetism', 'magnetic materials', 'diamagnetism',
  ], 0.5),
  phys('12th', 'emi', 'Electromagnetic Induction', [
    'faraday law', 'lenz law', 'motional emf', 'eddy currents', 'mutual inductance', 'self inductance',
    'electromagnetic induction', 'emi',
  ], 0.65),
  phys('12th', 'ac', 'Alternating Current', [
    'LCR', 'impedance', 'resonance', 'power factor', 'transformer', 'rms',
  ], 0.65),
  phys('12th', 'em_waves', 'Electromagnetic Waves', [
    'displacement current', 'spectrum', 'em waves',
  ], 0.5),
  phys('12th', 'ray_optics', 'Ray Optics and Optical Instruments', [
    'mirrors', 'lenses', 'refraction', 'total internal reflection', 'microscope', 'telescope',
  ], 0.6),
  phys('12th', 'wave_optics', 'Wave Optics', [
    'interference', 'diffraction', 'young double slit', 'huygens', 'polarization',
  ], 0.65),
  phys('12th', 'dual_nature', 'Dual Nature of Radiation and Matter', [
    'photoelectric effect', 'de broglie', 'photon',
  ], 0.55),
  phys('12th', 'atoms', 'Atoms', [
    'bohr model', 'hydrogen spectrum', 'rutherford',
  ], 0.5),
  phys('12th', 'nuclei', 'Nuclei', [
    'radioactivity', 'binding energy', 'nuclear fission', 'nuclear fusion', 'mass defect',
  ], 0.55),
  phys('12th', 'semiconductors', 'Semiconductor Electronics: Materials, Devices and Simple Circuits', [
    'p-n junction', 'diode', 'transistor', 'logic gates', 'rectifier',
  ], 0.55),
];

/* ── Mathematics XI (Code 041) ── */
const CBSE_11_MATH = [
  math('11th', 'sets', 'Sets', ['venn diagrams', 'union', 'intersection', 'complement'], 0.4),
  math('11th', 'relations_functions', 'Relations and Functions', [
    'domain', 'range', 'cartesian product', 'ordered pairs',
  ], 0.5),
  math('11th', 'trig_functions', 'Trigonometric Functions', [
    'trigonometry', 'trig identities', 'sin cos tan', 'radian', 'degree',
    'trigonometric equations', 'half-angle', 'compound angles', 'properties of triangles',
    'properties of triangle',
  ], 0.6),
  math('11th', 'complex_quadratic', 'Complex Numbers and Quadratic Equations', [
    'argand plane', 'complex numbers', 'quadratic',
  ], 0.55),
  math('11th', 'linear_inequalities', 'Linear Inequalities', ['number line', 'inequalities'], 0.45),
  math('11th', 'permutations_combinations', 'Permutations and Combinations', [
    'factorial', 'nPr', 'nCr', 'counting',
  ], 0.55),
  math('11th', 'binomial', 'Binomial Theorem', ['pascal triangle', 'binomial expansion'], 0.55),
  math('11th', 'sequence_series', 'Sequence and Series', [
    'AP', 'GP', 'arithmetic mean', 'geometric mean',
  ], 0.55),
  math('11th', 'straight_lines', 'Straight Lines', ['slope', 'intercept form', 'distance from a line'], 0.5),
  math('11th', 'conic_sections', 'Conic Sections', [
    'parabola', 'ellipse', 'hyperbola', 'circle',
  ], 0.6),
  math('11th', 'intro_3d', 'Introduction to Three-dimensional Geometry', [
    'coordinates', 'distance formula 3d',
  ], 0.5),
  math('11th', 'limits_derivatives', 'Limits and Derivatives', [
    'limits', 'derivative', 'differentiation intro',
  ], 0.6),
  math('11th', 'statistics', 'Statistics', ['mean deviation', 'variance', 'standard deviation'], 0.45),
  math('11th', 'probability', 'Probability', ['axiomatic probability', 'mutually exclusive'], 0.5),
];

/* ── Mathematics XII (Code 041) ── */
const CBSE_12_MATH = [
  math('12th', 'relations_functions', 'Relations and Functions', [
    'equivalence relation', 'one to one', 'onto',
  ], 0.5),
  math('12th', 'inverse_trig', 'Inverse Trigonometric Functions', [
    'inverse trig', 'principal value', 'inverse trigonometric', 'arcsin', 'arctan',
  ], 0.6),
  math('12th', 'matrices', 'Matrices', [
    'matrix operations', 'transpose', 'inverse matrix', 'symmetric matrix',
  ], 0.55),
  math('12th', 'determinants', 'Determinants', [
    'minors', 'cofactors', 'adjoint', 'system of linear equations',
  ], 0.55),
  math('12th', 'continuity_differentiability', 'Continuity and Differentiability', [
    'chain rule', 'logarithmic differentiation', 'parametric', 'second order derivatives',
  ], 0.65),
  math('12th', 'applications_derivatives', 'Applications of Derivatives', [
    'maxima minima', 'increasing decreasing', 'rate of change',
  ], 0.6),
  math('12th', 'integrals', 'Integrals', [
    'integration', 'substitution', 'partial fractions', 'definite integral',
  ], 0.65),
  math('12th', 'application_integrals', 'Application of the Integrals', [
    'area under curves',
  ], 0.6),
  math('12th', 'differential_equations', 'Differential Equations', [
    'order degree', 'separation of variables', 'homogeneous DE', 'linear DE',
  ], 0.65),
  math('12th', 'vectors', 'Vectors', [
    'dot product', 'cross product', 'direction cosines', 'position vector',
  ], 0.55),
  math('12th', '3d_geometry', 'Three-dimensional Geometry', [
    'skew lines', 'shortest distance', 'direction ratios',
  ], 0.6),
  math('12th', 'linear_programming', 'Linear Programming', [
    'feasible region', 'objective function', 'graphical method',
  ], 0.5),
  math('12th', 'probability', 'Probability', [
    'conditional probability', 'bayes theorem', 'probability distribution', 'bernoulli',
  ], 0.55),
];

/* ── Biology XI (Code 044) ── */
const CBSE_11_BIO = [
  bio('11th', 'living_world', 'The Living World', ['taxonomy', 'binomial nomenclature', 'species'], 0.4),
  bio('11th', 'biological_classification', 'Biological Classification', [
    'kingdoms', 'five kingdom', 'domains of life',
  ], 0.45),
  bio('11th', 'plant_kingdom', 'Plant Kingdom', [
    'algae', 'bryophyta', 'pteridophyta', 'gymnosperms', 'angiosperms',
  ], 0.5),
  bio('11th', 'animal_kingdom', 'Animal Kingdom', ['phyla', 'chordates', 'non chordates'], 0.5),
  bio('11th', 'morphology_plants', 'Morphology of Flowering Plants', [
    'root stem leaf', 'flower', 'solanaceae',
  ], 0.5),
  bio('11th', 'anatomy_plants', 'Anatomy of Flowering Plants', [
    'tissue systems', 'dicot', 'monocot',
  ], 0.5),
  bio('11th', 'structural_animals', 'Structural Organisation in Animals', [
    'tissues', 'frog', 'earthworm',
  ], 0.5),
  bio('11th', 'cell', 'Cell - The Unit of Life', [
    'cell organelles', 'prokaryotic', 'eukaryotic', 'plasma membrane',
  ], 0.55),
  bio('11th', 'biomolecules', 'Biomolecules', [
    'proteins', 'carbohydrates', 'lipids', 'nucleic acids', 'enzymes',
  ], 0.55),
  bio('11th', 'cell_cycle', 'Cell Cycle and Cell Division', [
    'mitosis', 'meiosis', 'cell cycle',
  ], 0.55),
  bio('11th', 'photosynthesis', 'Photosynthesis in Higher Plants', [
    'C3', 'C4', 'photophosphorylation', 'calvin cycle',
  ], 0.6),
  bio('11th', 'respiration_plants', 'Respiration in Plants', [
    'glycolysis', 'krebs', 'fermentation', 'ETC',
  ], 0.55),
  bio('11th', 'plant_growth', 'Plant Growth and Development', [
    'phytohormones', 'germination', 'differentiation',
  ], 0.5),
  bio('11th', 'breathing', 'Breathing and Exchange of Gases', [
    'respiratory system', 'gas exchange', 'oxygen dissociation',
  ], 0.5),
  bio('11th', 'circulation', 'Body Fluids and Circulation', [
    'heart', 'blood', 'ECG', 'cardiac cycle',
  ], 0.55),
  bio('11th', 'excretion', 'Excretory Products and their Elimination', [
    'nephron', 'kidney', 'urine formation',
  ], 0.5),
  bio('11th', 'locomotion', 'Locomotion and Movement', [
    'muscle', 'skeleton', 'joints',
  ], 0.5),
  bio('11th', 'neural', 'Neural Control and Coordination', [
    'neuron', 'CNS', 'nerve impulse', 'synapse',
  ], 0.55),
  bio('11th', 'chemical_coordination', 'Chemical Coordination and Integration', [
    'hormones', 'endocrine glands', 'feedback',
  ], 0.55),
];

/* ── Biology XII (Code 044) ── */
const CBSE_12_BIO = [
  bio('12th', 'sexual_reproduction_plants', 'Sexual Reproduction in Flowering Plants', [
    'pollination', 'double fertilization', 'embryo', 'seed', 'flower structure',
    'reproduction in lower and higher plants', 'reproduction in plants',
  ], 0.55),
  bio('12th', 'human_reproduction', 'Human Reproduction', [
    'gametogenesis', 'menstrual cycle', 'fertilisation', 'pregnancy', 'placenta',
  ], 0.55),
  bio('12th', 'reproductive_health', 'Reproductive Health', [
    'contraception', 'STDs', 'infertility', 'MTP',
  ], 0.45),
  bio('12th', 'inheritance', 'Principles of Inheritance and Variation', [
    'mendel', 'linkage', 'crossing over', 'sex determination', 'pedigree', 'mutation',
  ], 0.65),
  bio('12th', 'molecular_inheritance', 'Molecular Basis of Inheritance', [
    'DNA', 'RNA', 'replication', 'transcription', 'translation', 'genetic code', 'lac operon',
  ], 0.65),
  bio('12th', 'evolution', 'Evolution', [
    'darwin', 'hardy weinberg', 'adaptive radiation', 'speciation',
  ], 0.55),
  bio('12th', 'human_health', 'Human Health and Diseases', [
    'immunity', 'pathogens', 'cancer', 'AIDS', 'drugs',
  ], 0.5),
  bio('12th', 'microbes', 'Microbes in Human Welfare', [
    'fermentation', 'antibiotics', 'sewage treatment', 'biocontrol',
  ], 0.45),
  bio('12th', 'biotech_principles', 'Biotechnology - Principles and Processes', [
    'recombinant DNA', 'PCR', 'restriction enzymes', 'vectors', 'cloning',
  ], 0.6),
  bio('12th', 'biotech_applications', 'Biotechnology and its Applications', [
    'GM crops', 'gene therapy', 'transgenic', 'biopiracy',
  ], 0.55),
  bio('12th', 'organisms_populations', 'Organisms and Populations', [
    'population', 'adaptations', 'abiotic factors',
  ], 0.5),
  bio('12th', 'ecosystem', 'Ecosystem', [
    'food chain', 'ecological pyramids', 'productivity', 'decomposition',
  ], 0.5),
  bio('12th', 'biodiversity', 'Biodiversity and its Conservation', [
    'biodiversity hotspots', 'endangered', 'conservation', 'extinction',
  ], 0.5),
];

const SRSEC_CURRICULUM_SEED = [
  ...CBSE_11_CHEM,
  ...CBSE_12_CHEM,
  ...CBSE_11_PHYS,
  ...CBSE_12_PHYS,
  ...CBSE_11_MATH,
  ...CBSE_11_BIO,
  ...CBSE_12_MATH,
  ...CBSE_12_BIO,
];

module.exports = {
  SRSEC_CURRICULUM_SEED,
  CBSE_11_CHEM,
  CBSE_12_CHEM,
  CBSE_11_PHYS,
  CBSE_12_PHYS,
  CBSE_11_MATH,
  CBSE_12_MATH,
  CBSE_11_BIO,
  CBSE_12_BIO,
};
