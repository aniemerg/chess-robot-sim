export type Vector3Tuple = [number, number, number];

export type XArm5JointModel = {
  id: string;
  label: string;
  origin: {
    xyz: Vector3Tuple;
    rpy: Vector3Tuple;
  };
  axis: Vector3Tuple;
  lowerRad: number;
  upperRad: number;
  homeDeg: number;
  ik: boolean;
  visualRadius: number;
};

export const XARM5_SOURCE_NOTE =
  'Official xArm ROS xarm5_default_kinematics.yaml and xarm5.urdf.xacro.';

export const XARM5_JOINTS: XArm5JointModel[] = [
  {
    id: 'joint1',
    label: 'J1 base yaw',
    origin: { xyz: [0, 0, 0.267], rpy: [0, 0, 0] },
    axis: [0, 0, 1],
    lowerRad: -2 * Math.PI,
    upperRad: 2 * Math.PI,
    homeDeg: 0,
    ik: true,
    visualRadius: 0.058,
  },
  {
    id: 'joint2',
    label: 'J2 shoulder',
    origin: { xyz: [0, 0, 0], rpy: [-1.5708, 0, 0] },
    axis: [0, 0, 1],
    lowerRad: -2.059,
    upperRad: 2.0944,
    homeDeg: 0,
    ik: true,
    visualRadius: 0.048,
  },
  {
    id: 'joint3',
    label: 'J3 elbow',
    origin: { xyz: [0.0535, -0.2845, 0], rpy: [0, 0, 0] },
    axis: [0, 0, 1],
    lowerRad: -3.927,
    upperRad: 0.19198,
    homeDeg: 0,
    ik: true,
    visualRadius: 0.044,
  },
  {
    id: 'joint4',
    label: 'J4 wrist pitch',
    origin: { xyz: [0.0775, 0.3425, 0], rpy: [0, 0, 0] },
    axis: [0, 0, 1],
    lowerRad: -1.69297,
    upperRad: Math.PI,
    homeDeg: 0,
    ik: true,
    visualRadius: 0.036,
  },
  {
    id: 'joint5',
    label: 'J5 wrist roll',
    origin: { xyz: [0.076, 0.097, 0], rpy: [-1.5708, 0, 0] },
    axis: [0, 0, 1],
    lowerRad: -2 * Math.PI,
    upperRad: 2 * Math.PI,
    homeDeg: 0,
    ik: false,
    visualRadius: 0.03,
  },
];

export const XARM5_REFERENCE_LENGTHS = {
  j2ToJ3Meters: Math.hypot(0.0535, -0.2845),
  j3ToJ4Meters: Math.hypot(0.0775, 0.3425),
  j4ToJ5Meters: Math.hypot(0.076, 0.097),
};
