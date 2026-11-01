// scripts/migrations/data/kcMathsSeed.cjs
// CBSE Class 10 + Class 12 Mathematics KCs + prerequisites (2025-26 syllabus).
// `standard` values MUST match curriculum_standards.id from migration 039
// (format: cbse_10_math_<topic-slug> / cbse_12_math_<topic-slug>). Verify via:
//   node -e "require('dotenv').config(); const{createClient}=require('@libsql/client'); const db=createClient({url:process.env.TURSO_DATABASE_URL,authToken:process.env.TURSO_AUTH_TOKEN}); db.execute({sql:\"SELECT id,topic FROM curriculum_standards WHERE id LIKE 'cbse_10_math_%' OR id LIKE 'cbse_12_math_%'\"}).then(r=>console.log(r.rows))"
const CBSE_10_PREFIX = 'cbse_10_math_';

const kcs = [
  // Real Numbers (ch1)
  { id: 'kc_cbse_10_math_real_euclid', standard: CBSE_10_PREFIX + 'real_numbers', label: 'Euclid division lemma', slug: 'real_euclid', cognitive: 'understand' },
  { id: 'kc_cbse_10_math_real_fta', standard: CBSE_10_PREFIX + 'real_numbers', label: 'Fundamental Theorem of Arithmetic', slug: 'real_fta', cognitive: 'understand' },
  { id: 'kc_cbse_10_math_real_lcm_hcf', standard: CBSE_10_PREFIX + 'real_numbers', label: 'LCM and HCF via prime factorisation', slug: 'real_lcm_hcf', cognitive: 'apply' },
  { id: 'kc_cbse_10_math_real_irrational', standard: CBSE_10_PREFIX + 'real_numbers', label: 'Proving irrationality', slug: 'real_irrational', cognitive: 'analyze' },
  // Polynomials (ch2)
  { id: 'kc_cbse_10_math_poly_zeros', standard: CBSE_10_PREFIX + 'polynomials', label: 'Relationship between zeros and coefficients', slug: 'poly_zeros', cognitive: 'apply' },
  { id: 'kc_cbse_10_math_poly_division', standard: CBSE_10_PREFIX + 'polynomials', label: 'Division algorithm for polynomials', slug: 'poly_division', cognitive: 'apply' },
  // Pair of Linear Equations (ch3)
  { id: 'kc_cbse_10_math_linear_graphical', standard: CBSE_10_PREFIX + 'linear_pair', label: 'Graphical representation of a pair of linear equations', slug: 'linear_graphical', cognitive: 'apply' },
  { id: 'kc_cbse_10_math_linear_subst_elim', standard: CBSE_10_PREFIX + 'linear_pair', label: 'Substitution and elimination methods', slug: 'linear_subst_elim', cognitive: 'apply' },
  { id: 'kc_cbse_10_math_linear_word', standard: CBSE_10_PREFIX + 'linear_pair', label: 'Word problems on linear pairs', slug: 'linear_word', cognitive: 'analyze' },
  // Quadratic Equations (ch4)
  { id: 'kc_cbse_10_math_quad_factor', standard: CBSE_10_PREFIX + 'quadratic', label: 'Solving quadratics by factorisation', slug: 'quad_factor', cognitive: 'apply' },
  { id: 'kc_cbse_10_math_quad_complete', standard: CBSE_10_PREFIX + 'quadratic', label: 'Completing the square', slug: 'quad_complete', cognitive: 'apply' },
  { id: 'kc_cbse_10_math_quad_formula', standard: CBSE_10_PREFIX + 'quadratic', label: 'Quadratic formula', slug: 'quad_formula', cognitive: 'apply' },
  { id: 'kc_cbse_10_math_quad_discriminant', standard: CBSE_10_PREFIX + 'quadratic', label: 'Discriminant and nature of roots', slug: 'quad_discriminant', cognitive: 'analyze' },
  // Arithmetic Progressions (ch5)
  { id: 'kc_cbse_10_math_ap_nth', standard: CBSE_10_PREFIX + 'ap', label: 'nth term of an AP', slug: 'ap_nth', cognitive: 'apply' },
  { id: 'kc_cbse_10_math_ap_sum', standard: CBSE_10_PREFIX + 'ap', label: 'Sum of first n terms of an AP', slug: 'ap_sum', cognitive: 'apply' },
  { id: 'kc_cbse_10_math_ap_word', standard: CBSE_10_PREFIX + 'ap', label: 'AP word problems', slug: 'ap_word', cognitive: 'analyze' },
  // Triangles (ch6)
  { id: 'kc_cbse_10_math_tri_similar', standard: CBSE_10_PREFIX + 'triangles', label: 'Similar figures and similarity criteria', slug: 'tri_similar', cognitive: 'understand' },
  { id: 'kc_cbse_10_math_tri_area_similar', standard: CBSE_10_PREFIX + 'triangles', label: 'Areas of similar triangles', slug: 'tri_area_similar', cognitive: 'apply' },
  { id: 'kc_cbse_10_math_tri_pythagoras', standard: CBSE_10_PREFIX + 'triangles', label: 'Pythagoras theorem via similarity', slug: 'tri_pythagoras', cognitive: 'apply' },
  // Coordinate Geometry (ch7)
  { id: 'kc_cbse_10_math_coord_distance', standard: CBSE_10_PREFIX + 'coordinate', label: 'Distance formula', slug: 'coord_distance', cognitive: 'apply' },
  { id: 'kc_cbse_10_math_coord_section', standard: CBSE_10_PREFIX + 'coordinate', label: 'Section formula', slug: 'coord_section', cognitive: 'apply' },
  { id: 'kc_cbse_10_math_coord_area', standard: CBSE_10_PREFIX + 'coordinate', label: 'Area of a triangle from coordinates', slug: 'coord_area', cognitive: 'apply' },
  // Trigonometry (ch8)
  { id: 'kc_cbse_10_math_trig_ratios', standard: CBSE_10_PREFIX + 'trigonometry', label: 'Trigonometric ratios of acute angles', slug: 'trig_ratios', cognitive: 'apply' },
  { id: 'kc_cbse_10_math_trig_specific', standard: CBSE_10_PREFIX + 'trigonometry', label: 'Trig ratios of specific angles', slug: 'trig_specific', cognitive: 'remember' },
  { id: 'kc_cbse_10_math_trig_identities', standard: CBSE_10_PREFIX + 'trigonometry', label: 'Trigonometric identities', slug: 'trig_identities', cognitive: 'analyze' },
  // Applications of Trig (ch9)
  { id: 'kc_cbse_10_math_apptrig_elev_depress', standard: CBSE_10_PREFIX + 'trig_applications', label: 'Angle of elevation and depression', slug: 'apptrig_elev_depress', cognitive: 'understand' },
  { id: 'kc_cbse_10_math_apptrig_heights', standard: CBSE_10_PREFIX + 'trig_applications', label: 'Heights and distances problems', slug: 'apptrig_heights', cognitive: 'apply' },
  // Circles (ch10)
  { id: 'kc_cbse_10_math_circle_tangent', standard: CBSE_10_PREFIX + 'circles', label: 'Tangent perpendicular to radius', slug: 'circle_tangent', cognitive: 'understand' },
  { id: 'kc_cbse_10_math_circle_count', standard: CBSE_10_PREFIX + 'circles', label: 'Number of tangents from a point', slug: 'circle_count', cognitive: 'apply' },
  // Areas (ch11)
  { id: 'kc_cbse_10_math_area_sector', standard: CBSE_10_PREFIX + 'areas_circles', label: 'Area of sector and segment', slug: 'area_sector', cognitive: 'apply' },
  { id: 'kc_cbse_10_math_area_combine', standard: CBSE_10_PREFIX + 'areas_circles', label: 'Combination of figures', slug: 'area_combine', cognitive: 'analyze' },
  // Surface Areas & Volumes (ch12)
  { id: 'kc_cbse_10_math_sav_cyl_cone_sph', standard: CBSE_10_PREFIX + 'surface_volumes', label: 'SA and volume of cylinder, cone, sphere', slug: 'sav_cyl_cone_sph', cognitive: 'apply' },
  { id: 'kc_cbse_10_math_sav_combine', standard: CBSE_10_PREFIX + 'surface_volumes', label: 'Combination of solids', slug: 'sav_combine', cognitive: 'analyze' },
  // Statistics (ch13)
  { id: 'kc_cbse_10_math_stat_mean', standard: CBSE_10_PREFIX + 'statistics', label: 'Mean of grouped data', slug: 'stat_mean', cognitive: 'apply' },
  { id: 'kc_cbse_10_math_stat_mode', standard: CBSE_10_PREFIX + 'statistics', label: 'Mode of grouped data', slug: 'stat_mode', cognitive: 'apply' },
  { id: 'kc_cbse_10_math_stat_median', standard: CBSE_10_PREFIX + 'statistics', label: 'Median of grouped data', slug: 'stat_median', cognitive: 'apply' },
  // Probability (ch14)
  { id: 'kc_cbse_10_math_prob_classical', standard: CBSE_10_PREFIX + 'probability', label: 'Classical definition of probability', slug: 'prob_classical', cognitive: 'understand' },
  { id: 'kc_cbse_10_math_prob_events', standard: CBSE_10_PREFIX + 'probability', label: 'Complementary and exhaustive events', slug: 'prob_events', cognitive: 'apply' },
];

// Prerequisite edges: each tuple is [dependentKcId, prerequisiteKcId] —
// the KC in position 0 DEPENDS ON the KC in position 1
// (e.g. quad_formula depends on quad_complete).
const prerequisites = [
  ['kc_cbse_10_math_real_lcm_hcf', 'kc_cbse_10_math_real_fta'],
  ['kc_cbse_10_math_real_irrational', 'kc_cbse_10_math_real_fta'],
  ['kc_cbse_10_math_poly_division', 'kc_cbse_10_math_poly_zeros'],
  ['kc_cbse_10_math_linear_subst_elim', 'kc_cbse_10_math_linear_graphical'],
  ['kc_cbse_10_math_linear_word', 'kc_cbse_10_math_linear_subst_elim'],
  ['kc_cbse_10_math_quad_factor', 'kc_cbse_10_math_poly_division'],
  ['kc_cbse_10_math_quad_complete', 'kc_cbse_10_math_quad_factor'],
  ['kc_cbse_10_math_quad_formula', 'kc_cbse_10_math_quad_complete'],
  ['kc_cbse_10_math_quad_discriminant', 'kc_cbse_10_math_quad_formula'],
  ['kc_cbse_10_math_ap_nth', 'kc_cbse_10_math_real_lcm_hcf'],
  ['kc_cbse_10_math_ap_sum', 'kc_cbse_10_math_ap_nth'],
  ['kc_cbse_10_math_ap_word', 'kc_cbse_10_math_ap_sum'],
  ['kc_cbse_10_math_tri_area_similar', 'kc_cbse_10_math_tri_similar'],
  ['kc_cbse_10_math_tri_pythagoras', 'kc_cbse_10_math_tri_area_similar'],
  ['kc_cbse_10_math_coord_section', 'kc_cbse_10_math_coord_distance'],
  ['kc_cbse_10_math_coord_area', 'kc_cbse_10_math_coord_section'],
  ['kc_cbse_10_math_trig_specific', 'kc_cbse_10_math_trig_ratios'],
  ['kc_cbse_10_math_trig_identities', 'kc_cbse_10_math_trig_specific'],
  ['kc_cbse_10_math_apptrig_heights', 'kc_cbse_10_math_trig_ratios'],
  ['kc_cbse_10_math_area_combine', 'kc_cbse_10_math_area_sector'],
  ['kc_cbse_10_math_sav_combine', 'kc_cbse_10_math_sav_cyl_cone_sph'],
  ['kc_cbse_10_math_stat_mode', 'kc_cbse_10_math_stat_mean'],
  ['kc_cbse_10_math_stat_median', 'kc_cbse_10_math_stat_mean'],
  ['kc_cbse_10_math_prob_events', 'kc_cbse_10_math_prob_classical'],
];

// ── CBSE Class 12 Mathematics (2025-26 syllabus) ──
// curriculum_standards IDs: cbse_12_math_<slug> (confirmed in DB, 13 topics)
const CBSE_12_PREFIX = 'cbse_12_math_';

kcs.push(
  // Relations and Functions
  { id: 'kc_cbse_12_math_rf_types', standard: CBSE_12_PREFIX + 'relations_functions', label: 'Types of relations (reflexive, symmetric, transitive, equivalence)', slug: 'rf_types', cognitive: 'understand' },
  { id: 'kc_cbse_12_math_rf_composition', standard: CBSE_12_PREFIX + 'relations_functions', label: 'Composition and inverse of functions', slug: 'rf_composition', cognitive: 'apply' },
  // Inverse Trigonometric Functions
  { id: 'kc_cbse_12_math_itr_domain', standard: CBSE_12_PREFIX + 'inverse_trig', label: 'Domain and range of inverse trig functions', slug: 'itr_domain', cognitive: 'understand' },
  { id: 'kc_cbse_12_math_itr_properties', standard: CBSE_12_PREFIX + 'inverse_trig', label: 'Properties of inverse trig functions', slug: 'itr_properties', cognitive: 'apply' },
  { id: 'kc_cbse_12_math_itr_identities', standard: CBSE_12_PREFIX + 'inverse_trig', label: 'Inverse trig identities and formulas', slug: 'itr_identities', cognitive: 'analyze' },
  // Matrices
  { id: 'kc_cbse_12_math_mat_ops', standard: CBSE_12_PREFIX + 'matrices', label: 'Matrix operations (add, multiply, transpose)', slug: 'mat_ops', cognitive: 'apply' },
  { id: 'kc_cbse_12_math_mat_symmetric', standard: CBSE_12_PREFIX + 'matrices', label: 'Symmetric and skew-symmetric matrices', slug: 'mat_symmetric', cognitive: 'understand' },
  { id: 'kc_cbse_12_math_mat_invertible', standard: CBSE_12_PREFIX + 'matrices', label: 'Invertible matrices and inverse by elementary operations', slug: 'mat_invertible', cognitive: 'apply' },
  // Determinants
  { id: 'kc_cbse_12_math_det_compute', standard: CBSE_12_PREFIX + 'determinants', label: 'Determinant of 2x2 and 3x3 matrices', slug: 'det_compute', cognitive: 'apply' },
  { id: 'kc_cbse_12_math_det_area', standard: CBSE_12_PREFIX + 'determinants', label: 'Area of triangle using determinants', slug: 'det_area', cognitive: 'apply' },
  { id: 'kc_cbse_12_math_det_solve', standard: CBSE_12_PREFIX + 'determinants', label: 'Solving system of linear equations using determinants (Cramer rule)', slug: 'det_solve', cognitive: 'apply' },
  // Continuity and Differentiability
  { id: 'kc_cbse_12_math_cont_check', standard: CBSE_12_PREFIX + 'continuity_differentiability', label: 'Checking continuity of a function', slug: 'cont_check', cognitive: 'apply' },
  { id: 'kc_cbse_12_math_diff_rules', standard: CBSE_12_PREFIX + 'continuity_differentiability', label: 'Differentiation rules (chain, product, quotient)', slug: 'diff_rules', cognitive: 'apply' },
  { id: 'kc_cbse_12_math_diff_implicit', standard: CBSE_12_PREFIX + 'continuity_differentiability', label: 'Implicit and logarithmic differentiation', slug: 'diff_implicit', cognitive: 'analyze' },
  { id: 'kc_cbse_12_math_diff_parametric', standard: CBSE_12_PREFIX + 'continuity_differentiability', label: 'Parametric and second-order derivatives', slug: 'diff_parametric', cognitive: 'apply' },
  // Applications of Derivatives
  { id: 'kc_cbse_12_math_aod_rate', standard: CBSE_12_PREFIX + 'applications_derivatives', label: 'Rate of change of quantities', slug: 'aod_rate', cognitive: 'apply' },
  { id: 'kc_cbse_12_math_aod_incr_dec', standard: CBSE_12_PREFIX + 'applications_derivatives', label: 'Increasing and decreasing functions', slug: 'aod_incr_dec', cognitive: 'apply' },
  { id: 'kc_cbse_12_math_aod_maxmin', standard: CBSE_12_PREFIX + 'applications_derivatives', label: 'Maxima and minima using derivatives', slug: 'aod_maxmin', cognitive: 'analyze' },
  { id: 'kc_cbse_12_math_aod_tangent', standard: CBSE_12_PREFIX + 'applications_derivatives', label: 'Tangents and normals', slug: 'aod_tangent', cognitive: 'apply' },
  // Integrals
  { id: 'kc_cbse_12_math_int_indefinite', standard: CBSE_12_PREFIX + 'integrals', label: 'Indefinite integrals and standard formulas', slug: 'int_indefinite', cognitive: 'apply' },
  { id: 'kc_cbse_12_math_int_substitution', standard: CBSE_12_PREFIX + 'integrals', label: 'Integration by substitution', slug: 'int_substitution', cognitive: 'apply' },
  { id: 'kc_cbse_12_math_int_parts', standard: CBSE_12_PREFIX + 'integrals', label: 'Integration by parts', slug: 'int_parts', cognitive: 'apply' },
  { id: 'kc_cbse_12_math_int_partial', standard: CBSE_12_PREFIX + 'integrals', label: 'Partial fractions in integration', slug: 'int_partial', cognitive: 'apply' },
  { id: 'kc_cbse_12_math_int_definite', standard: CBSE_12_PREFIX + 'integrals', label: 'Definite integrals and properties', slug: 'int_definite', cognitive: 'apply' },
  // Application of Integrals
  { id: 'kc_cbse_12_math_aint_area', standard: CBSE_12_PREFIX + 'application_integrals', label: 'Area under curves and between curves', slug: 'aint_area', cognitive: 'apply' },
  // Differential Equations
  { id: 'kc_cbse_12_math_de_form', standard: CBSE_12_PREFIX + 'differential_equations', label: 'Order, degree, and formation of DEs', slug: 'de_form', cognitive: 'understand' },
  { id: 'kc_cbse_12_math_de_solve', standard: CBSE_12_PREFIX + 'differential_equations', label: 'Solving first-order linear DEs (variable separable, homogeneous)', slug: 'de_solve', cognitive: 'apply' },
  // Vectors
  { id: 'kc_cbse_12_math_vec_ops', standard: CBSE_12_PREFIX + 'vectors', label: 'Vector addition, scalar multiplication, dot and cross product', slug: 'vec_ops', cognitive: 'apply' },
  { id: 'kc_cbse_12_math_vec_proj', standard: CBSE_12_PREFIX + 'vectors', label: 'Projection of vectors and section formula', slug: 'vec_proj', cognitive: 'apply' },
  // Three-dimensional Geometry
  { id: 'kc_cbse_12_math_3d_lines', standard: CBSE_12_PREFIX + '3d_geometry', label: 'Direction cosines and ratios', slug: '3d_lines', cognitive: 'understand' },
  { id: 'kc_cbse_12_math_3d_plane', standard: CBSE_12_PREFIX + '3d_geometry', label: 'Equation of line and plane in 3D', slug: '3d_plane', cognitive: 'apply' },
  { id: 'kc_cbse_12_math_3d_distance', standard: CBSE_12_PREFIX + '3d_geometry', label: 'Distance between skew lines and point-plane distance', slug: '3d_distance', cognitive: 'analyze' },
  // Linear Programming
  { id: 'kc_cbse_12_math_lp_form', standard: CBSE_12_PREFIX + 'linear_programming', label: 'Formulating and solving LPP graphically', slug: 'lp_form', cognitive: 'apply' },
  // Probability
  { id: 'kc_cbse_12_math_prob_conditional', standard: CBSE_12_PREFIX + 'probability', label: 'Conditional probability and Bayes theorem', slug: 'prob_conditional', cognitive: 'apply' },
  { id: 'kc_cbse_12_math_prob_random', standard: CBSE_12_PREFIX + 'probability', label: 'Random variables and probability distributions', slug: 'prob_random', cognitive: 'apply' },
  { id: 'kc_cbse_12_math_prob_binomial', standard: CBSE_12_PREFIX + 'probability', label: 'Bernoulli trials and binomial distribution', slug: 'prob_binomial', cognitive: 'apply' },
);

prerequisites.push(
  ['kc_cbse_12_math_rf_composition', 'kc_cbse_12_math_rf_types'],
  ['kc_cbse_12_math_itr_properties', 'kc_cbse_12_math_itr_domain'],
  ['kc_cbse_12_math_itr_identities', 'kc_cbse_12_math_itr_properties'],
  ['kc_cbse_12_math_mat_symmetric', 'kc_cbse_12_math_mat_ops'],
  ['kc_cbse_12_math_mat_invertible', 'kc_cbse_12_math_mat_ops'],
  ['kc_cbse_12_math_det_area', 'kc_cbse_12_math_det_compute'],
  ['kc_cbse_12_math_det_solve', 'kc_cbse_12_math_det_compute'],
  ['kc_cbse_12_math_diff_rules', 'kc_cbse_12_math_cont_check'],
  ['kc_cbse_12_math_diff_implicit', 'kc_cbse_12_math_diff_rules'],
  ['kc_cbse_12_math_diff_parametric', 'kc_cbse_12_math_diff_rules'],
  ['kc_cbse_12_math_aod_incr_dec', 'kc_cbse_12_math_diff_rules'],
  ['kc_cbse_12_math_aod_maxmin', 'kc_cbse_12_math_aod_incr_dec'],
  ['kc_cbse_12_math_aod_tangent', 'kc_cbse_12_math_diff_rules'],
  ['kc_cbse_12_math_int_substitution', 'kc_cbse_12_math_int_indefinite'],
  ['kc_cbse_12_math_int_parts', 'kc_cbse_12_math_int_substitution'],
  ['kc_cbse_12_math_int_definite', 'kc_cbse_12_math_int_indefinite'],
  ['kc_cbse_12_math_aint_area', 'kc_cbse_12_math_int_definite'],
  ['kc_cbse_12_math_de_solve', 'kc_cbse_12_math_de_form'],
  ['kc_cbse_12_math_vec_proj', 'kc_cbse_12_math_vec_ops'],
  ['kc_cbse_12_math_3d_plane', 'kc_cbse_12_math_3d_lines'],
  ['kc_cbse_12_math_3d_distance', 'kc_cbse_12_math_3d_plane'],
  ['kc_cbse_12_math_prob_conditional', 'kc_cbse_12_math_prob_random'],
  ['kc_cbse_12_math_prob_binomial', 'kc_cbse_12_math_prob_random'],
);

module.exports = { kcs, prerequisites };
