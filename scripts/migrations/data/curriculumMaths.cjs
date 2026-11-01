/**
 * Seed catalogue: ICSE + CBSE Mathematics, grades 8–10.
 * Stable ids so re-runs and cross-migration joins converge.
 */

function entry(board, grade, slug, topic, subTopics, difficultyWeight = 0.5) {
  const boardKey = String(board).toLowerCase();
  const gradeKey = String(grade).replace(/[^0-9]/g, '');
  return {
    id: `${boardKey}_${gradeKey}_math_${slug}`,
    board,
    grade,
    subject: 'Mathematics',
    topic,
    subTopics,
    difficultyWeight,
  };
}

const ICSE_8 = [
  entry('ICSE', '8th', 'rational_numbers', 'Rational Numbers', ['operations', 'representation on number line'], 0.4),
  entry('ICSE', '8th', 'exponents', 'Exponents and Powers', ['laws of exponents', 'scientific notation'], 0.45),
  entry('ICSE', '8th', 'squares_cubes', 'Squares, Cubes and Roots', ['perfect squares', 'cube roots'], 0.5),
  entry('ICSE', '8th', 'algebraic_expressions', 'Algebraic Expressions', ['terms', 'operations', 'identities intro'], 0.5),
  entry('ICSE', '8th', 'linear_equations', 'Linear Equations in One Variable', ['forming equations', 'solving'], 0.55),
  entry('ICSE', '8th', 'ratio_proportion', 'Ratio and Proportion', ['direct proportion', 'inverse proportion'], 0.45),
  entry('ICSE', '8th', 'percentage', 'Percentage and Applications', ['profit loss', 'simple interest'], 0.5),
  entry('ICSE', '8th', 'quadrilaterals', 'Understanding Quadrilaterals', ['parallelogram', 'rectangle', 'rhombus'], 0.5),
  entry('ICSE', '8th', 'practical_geometry', 'Practical Geometry', ['construction of quadrilaterals'], 0.55),
  entry('ICSE', '8th', 'mensuration', 'Mensuration', ['area', 'volume', 'surface area'], 0.55),
  entry('ICSE', '8th', 'data_handling', 'Data Handling', ['bar graphs', 'pie charts', 'chance'], 0.4),
  entry('ICSE', '8th', 'direct_inverse', 'Direct and Inverse Variation', ['word problems'], 0.5),
];

const ICSE_9 = [
  entry('ICSE', '9th', 'number_system', 'Number System (Irrationals)', ['surds', 'rationalisation'], 0.55),
  entry('ICSE', '9th', 'polynomials', 'Polynomials', ['zeros', 'factorisation', 'remainder theorem'], 0.55),
  entry('ICSE', '9th', 'coordinate_geometry', 'Coordinate Geometry', ['cartesian plane', 'distance'], 0.5),
  entry('ICSE', '9th', 'linear_equations_2', 'Linear Equations in Two Variables', ['graphical solutions'], 0.55),
  entry('ICSE', '9th', 'lines_angles', 'Lines and Angles', ['parallel lines', 'transversal'], 0.5),
  entry('ICSE', '9th', 'triangles', 'Triangles', ['congruence', 'inequalities'], 0.55),
  entry('ICSE', '9th', 'quadrilaterals', 'Quadrilaterals', ['properties', 'mid-point theorem'], 0.55),
  entry('ICSE', '9th', 'circles', 'Circles', ['chords', 'angles in semicircle'], 0.6),
  entry('ICSE', '9th', 'herons', "Heron's Formula", ['area of triangle'], 0.45),
  entry('ICSE', '9th', 'surface_volumes', 'Surface Areas and Volumes', ['cone', 'sphere', 'cylinder'], 0.6),
  entry('ICSE', '9th', 'statistics', 'Statistics', ['mean', 'median', 'mode', 'bar graphs'], 0.45),
  entry('ICSE', '9th', 'probability', 'Probability', ['experimental probability'], 0.45),
];

const ICSE_10 = [
  entry('ICSE', '10th', 'gst', 'Goods and Services Tax (GST)', ['calculation', 'invoice problems'], 0.4),
  entry('ICSE', '10th', 'banking', 'Banking', ['recurring deposit', 'interest'], 0.45),
  entry('ICSE', '10th', 'shares', 'Shares and Dividends', ['face value', 'market value'], 0.5),
  entry('ICSE', '10th', 'linear_inequations', 'Linear Inequations', ['number line', 'solution sets'], 0.5),
  entry('ICSE', '10th', 'quadratic', 'Quadratic Equations', ['factorisation', 'formula', 'nature of roots'], 0.65),
  entry('ICSE', '10th', 'ratio_proportion', 'Ratio and Proportion', ['componendo', 'dividendo'], 0.55),
  entry('ICSE', '10th', 'matrices', 'Matrices', ['operations', 'equality'], 0.5),
  entry('ICSE', '10th', 'reflection', 'Reflection', ['invariant points'], 0.45),
  entry('ICSE', '10th', 'section_midpoint', 'Section and Mid-Point Formula', ['internal division'], 0.55),
  entry('ICSE', '10th', 'equation_line', 'Equation of a Line', ['slope', 'two-point form'], 0.6),
  entry('ICSE', '10th', 'similarity', 'Similarity of Triangles', ['AA', 'basic proportionality'], 0.6),
  entry('ICSE', '10th', 'circles', 'Circles', ['tangent', 'alternate segment'], 0.65),
  entry('ICSE', '10th', 'constructions', 'Constructions', ['tangents', 'triangles'], 0.55),
  entry('ICSE', '10th', 'trig_ratios', 'Trigonometric Ratios', ['sin cos tan', 'identities intro'], 0.6),
  entry('ICSE', '10th', 'trig_identities', 'Trigonometric Identities', ['sin²+cos²=1', 'proving identities'], 0.7),
  entry('ICSE', '10th', 'heights_distances', 'Heights and Distances', ['angle of elevation'], 0.65),
  entry('ICSE', '10th', 'mensuration', 'Mensuration', ['cylinder cone sphere combinations'], 0.65),
  entry('ICSE', '10th', 'statistics', 'Statistics', ['ogive', 'median from graph'], 0.5),
  entry('ICSE', '10th', 'probability', 'Probability', ['simple events'], 0.5),
];

const CBSE_8 = [
  entry('CBSE', '8th', 'rational_numbers', 'Rational Numbers', ['closure', 'properties'], 0.4),
  entry('CBSE', '8th', 'linear_equations', 'Linear Equations in One Variable', ['applications'], 0.5),
  entry('CBSE', '8th', 'quadrilaterals', 'Understanding Quadrilaterals', ['polygons', 'parallelogram'], 0.5),
  entry('CBSE', '8th', 'practical_geometry', 'Practical Geometry', ['constructing quadrilaterals'], 0.55),
  entry('CBSE', '8th', 'data_handling', 'Data Handling', ['grouped data', 'chance and probability'], 0.45),
  entry('CBSE', '8th', 'squares_cubes', 'Squares and Square Roots', ['estimating roots'], 0.5),
  entry('CBSE', '8th', 'cubes_roots', 'Cubes and Cube Roots', ['perfect cubes'], 0.5),
  entry('CBSE', '8th', 'comparing_quantities', 'Comparing Quantities', ['percentage', 'compound interest intro'], 0.55),
  entry('CBSE', '8th', 'algebraic_expressions', 'Algebraic Expressions and Identities', ['(a±b)²', 'a²−b²'], 0.55),
  entry('CBSE', '8th', 'mensuration', 'Mensuration', ['surface area', 'volume'], 0.55),
  entry('CBSE', '8th', 'exponents', 'Exponents and Powers', ['laws', 'standard form'], 0.45),
  entry('CBSE', '8th', 'direct_inverse', 'Direct and Inverse Proportions', ['word problems'], 0.5),
  entry('CBSE', '8th', 'factorisation', 'Factorisation', ['common factors', 'identities'], 0.55),
  entry('CBSE', '8th', 'intro_graphs', 'Introduction to Graphs', ['linear graphs'], 0.4),
];

const CBSE_9 = [
  entry('CBSE', '9th', 'number_system', 'Number Systems', ['irrationals', 'real numbers'], 0.5),
  entry('CBSE', '9th', 'polynomials', 'Polynomials', ['zeros', 'factorisation', 'algebraic identities'], 0.55),
  entry('CBSE', '9th', 'coordinate_geometry', 'Coordinate Geometry', ['plotting points'], 0.45),
  entry('CBSE', '9th', 'linear_equations_2', 'Linear Equations in Two Variables', ['solutions', 'graph'], 0.55),
  entry('CBSE', '9th', 'euclid', "Introduction to Euclid's Geometry", ['axioms', 'postulates'], 0.4),
  entry('CBSE', '9th', 'lines_angles', 'Lines and Angles', ['parallel lines'], 0.5),
  entry('CBSE', '9th', 'triangles', 'Triangles', ['congruence criteria'], 0.55),
  entry('CBSE', '9th', 'quadrilaterals', 'Quadrilaterals', ['properties of parallelogram'], 0.55),
  entry('CBSE', '9th', 'circles', 'Circles', ['angle subtended by chord'], 0.6),
  entry('CBSE', '9th', 'herons', "Heron's Formula", ['area'], 0.45),
  entry('CBSE', '9th', 'surface_volumes', 'Surface Areas and Volumes', ['cuboid', 'cylinder', 'cone', 'sphere'], 0.6),
  entry('CBSE', '9th', 'statistics', 'Statistics', ['frequency', 'mean median mode'], 0.45),
  entry('CBSE', '9th', 'probability', 'Probability', ['empirical probability'], 0.45),
];

const CBSE_10 = [
  entry('CBSE', '10th', 'real_numbers', 'Real Numbers', ['Euclid algorithm', 'fundamental theorem'], 0.55),
  entry('CBSE', '10th', 'polynomials', 'Polynomials', ['relationship zeros coefficients'], 0.55),
  entry('CBSE', '10th', 'linear_pair', 'Pair of Linear Equations in Two Variables', ['substitution', 'elimination', 'cross multiplication'], 0.6),
  entry('CBSE', '10th', 'quadratic', 'Quadratic Equations', ['nature of roots', 'applications'], 0.65),
  entry('CBSE', '10th', 'ap', 'Arithmetic Progressions', ['nth term', 'sum'], 0.55),
  entry('CBSE', '10th', 'triangles', 'Triangles', ['similarity', 'Pythagoras'], 0.6),
  entry('CBSE', '10th', 'coordinate', 'Coordinate Geometry', ['distance', 'section formula', 'area of triangle'], 0.6),
  entry('CBSE', '10th', 'trigonometry', 'Introduction to Trigonometry', ['ratios', 'identities'], 0.65),
  entry('CBSE', '10th', 'trig_applications', 'Some Applications of Trigonometry', ['heights and distances'], 0.65),
  entry('CBSE', '10th', 'circles', 'Circles', ['tangent properties'], 0.6),
  entry('CBSE', '10th', 'areas_circles', 'Areas Related to Circles', ['sectors', 'segments'], 0.55),
  entry('CBSE', '10th', 'surface_volumes', 'Surface Areas and Volumes', ['combinations of solids'], 0.65),
  entry('CBSE', '10th', 'statistics', 'Statistics', ['mean', 'median', 'mode of grouped data'], 0.55),
  entry('CBSE', '10th', 'probability', 'Probability', ['theoretical probability'], 0.5),
];

const MATHS_CURRICULUM_SEED = [
  ...ICSE_8,
  ...ICSE_9,
  ...ICSE_10,
  ...CBSE_8,
  ...CBSE_9,
  ...CBSE_10,
];

module.exports = { MATHS_CURRICULUM_SEED };
