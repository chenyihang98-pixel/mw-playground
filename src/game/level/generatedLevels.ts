// 由生成器做出的内置关卡（P5）：说明书、种子和冻结的布局。
// 以冻结的布局为准：生成器版本变了也不重新生成，规则（时间限制等）也用这里保存的值。
// 这些数据由生成器（generatorVersion 1）按下面的说明书和种子做出，再把布局的 id 改成内置关卡的 id；之后不再改动。
// 第 1 关（gen-1）同时是“随机一关”全部失败时的回退关卡。测试保证它们都通过硬检查。

import type { BriefInput } from './gen/brief';
import type { LevelLayoutInput } from './schema';

export interface FrozenLevel {
  readonly id: string;
  readonly seed: string;
  readonly schemaVersion: number;
  readonly generatorVersion: number;
  readonly brief: BriefInput;
  readonly rules: { readonly timeLimit: number; readonly target: number; readonly penaltySeconds: number; readonly cooldownSeconds: number };
  readonly layout: LevelLayoutInput;
}

export const FALLBACK_LEVEL_ID = 'gen-1';

export const GENERATED_LEVELS: readonly FrozenLevel[] = [
  {
    "id": "gen-1",
    "seed": "builtin-gen-1",
    "schemaVersion": 1,
    "generatorVersion": 1,
    "brief": {
      "schemaVersion": 1,
      "tier": "small",
      "density": "low",
      "platforms": 1,
      "collectibles": 3,
      "distribution": "scattered",
      "guards": 1,
      "patrol": "back-and-forth",
      "intent": "relaxed",
      "visual": {
        "theme": "grass",
        "time": "day",
        "weather": "clear"
      },
      "title": "晨光草地",
      "opening": "宝石散落在草地上。小心那个来回巡逻的守卫，坡道能带你走上高台。",
      "cast": []
    },
    "rules": {
      "timeLimit": 35,
      "target": 3,
      "penaltySeconds": 10,
      "cooldownSeconds": 2
    },
    "layout": {
      "id": "gen-1",
      "name": "晨光草地",
      "size": {
        "width": 24,
        "depth": 24
      },
      "spawn": {
        "x": -5,
        "z": -1,
        "yaw": 2.034
      },
      "boxes": [
        {
          "id": "box-1",
          "center": {
            "x": 4.924,
            "z": -4.903
          },
          "size": {
            "x": 1,
            "z": 0.816
          },
          "height": 1.698
        },
        {
          "id": "box-2",
          "center": {
            "x": 5.017,
            "z": -7.156
          },
          "size": {
            "x": 1.254,
            "z": 0.94
          },
          "height": 1.099
        },
        {
          "id": "box-3",
          "center": {
            "x": 7.09,
            "z": -9.124
          },
          "size": {
            "x": 1.109,
            "z": 0.909
          },
          "height": 2.028
        },
        {
          "id": "box-4",
          "center": {
            "x": -7.038,
            "z": -8.861
          },
          "size": {
            "x": 0.892,
            "z": 0.81
          },
          "height": 1.574
        },
        {
          "id": "box-5",
          "center": {
            "x": -4.999,
            "z": -4.874
          },
          "size": {
            "x": 1.296,
            "z": 0.897
          },
          "height": 0.979
        },
        {
          "id": "box-6",
          "center": {
            "x": -1.058,
            "z": 7.095
          },
          "size": {
            "x": 1.029,
            "z": 0.879
          },
          "height": 0.762
        },
        {
          "id": "box-7",
          "center": {
            "x": 4.893,
            "z": 1.027
          },
          "size": {
            "x": 1.009,
            "z": 1.191
          },
          "height": 1.992
        },
        {
          "id": "box-8",
          "center": {
            "x": -8.808,
            "z": 1.059
          },
          "size": {
            "x": 0.909,
            "z": 0.868
          },
          "height": 0.858
        }
      ],
      "platforms": [
        {
          "id": "plat-1",
          "center": {
            "x": 2,
            "z": -8
          },
          "size": {
            "x": 3.3,
            "z": 3.3
          }
        }
      ],
      "ramps": [
        {
          "id": "ramp-1",
          "platform": "plat-1",
          "side": "+z",
          "length": 3.254,
          "width": 1.281,
          "offset": 1
        }
      ],
      "collectibles": [
        {
          "id": "gem-1",
          "position": {
            "x": -5,
            "z": 5
          }
        },
        {
          "id": "gem-2",
          "position": {
            "x": -1,
            "z": -3
          }
        },
        {
          "id": "gem-3",
          "position": {
            "x": 9,
            "z": -1
          }
        }
      ],
      "guards": [
        {
          "id": "guard-1",
          "route": [
            {
              "x": 7,
              "z": 5
            },
            {
              "x": 3,
              "z": 5
            },
            {
              "x": 3,
              "z": -1
            },
            {
              "x": 3,
              "z": 5
            }
          ]
        }
      ],
      "timeLimit": 35,
      "target": 3
    }
  },
  {
    "id": "gen-2",
    "seed": "builtin-gen-2",
    "schemaVersion": 1,
    "generatorVersion": 1,
    "brief": {
      "schemaVersion": 1,
      "tier": "medium",
      "density": "mid",
      "platforms": 2,
      "collectibles": 5,
      "distribution": "edge",
      "guards": 2,
      "patrol": "loop",
      "intent": "normal",
      "visual": {
        "theme": "sand",
        "time": "dusk",
        "weather": "fog"
      },
      "title": "沙丘黄昏",
      "opening": "黄昏起了雾，宝石都在地图边上。两个守卫绕着圈巡逻。",
      "cast": []
    },
    "rules": {
      "timeLimit": 51,
      "target": 5,
      "penaltySeconds": 10,
      "cooldownSeconds": 2
    },
    "layout": {
      "id": "gen-2",
      "name": "沙丘黄昏",
      "size": {
        "width": 36,
        "depth": 36
      },
      "spawn": {
        "x": -3,
        "z": -11,
        "yaw": 3.142
      },
      "boxes": [
        {
          "id": "box-1",
          "center": {
            "x": -3.092,
            "z": -7.006
          },
          "size": {
            "x": 0.929,
            "z": 1.281
          },
          "height": 0.832
        },
        {
          "id": "box-2",
          "center": {
            "x": 15.099,
            "z": 11.127
          },
          "size": {
            "x": 0.92,
            "z": 0.986
          },
          "height": 0.792
        },
        {
          "id": "box-3",
          "center": {
            "x": -14.996,
            "z": -10.995
          },
          "size": {
            "x": 1.281,
            "z": 1.268
          },
          "height": 0.773
        },
        {
          "id": "box-4",
          "center": {
            "x": -8.949,
            "z": 1.075
          },
          "size": {
            "x": 1.166,
            "z": 1.029
          },
          "height": 1.659
        },
        {
          "id": "box-5",
          "center": {
            "x": -6.939,
            "z": -11.044
          },
          "size": {
            "x": 1.089,
            "z": 1.09
          },
          "height": 0.625
        },
        {
          "id": "box-6",
          "center": {
            "x": 5.071,
            "z": -5.053
          },
          "size": {
            "x": 1.13,
            "z": 1.102
          },
          "height": 1.239
        },
        {
          "id": "box-7",
          "center": {
            "x": 0.991,
            "z": -12.935
          },
          "size": {
            "x": 1.172,
            "z": 1.111
          },
          "height": 0.945
        },
        {
          "id": "box-8",
          "center": {
            "x": 7.055,
            "z": -13.028
          },
          "size": {
            "x": 1.006,
            "z": 1.013
          },
          "height": 2.239
        },
        {
          "id": "box-9",
          "center": {
            "x": 15.06,
            "z": -1.037
          },
          "size": {
            "x": 1.099,
            "z": 0.981
          },
          "height": 1.269
        },
        {
          "id": "box-10",
          "center": {
            "x": -2.872,
            "z": -3.008
          },
          "size": {
            "x": 1.001,
            "z": 1.223
          },
          "height": 1.187
        },
        {
          "id": "box-11",
          "center": {
            "x": -6.968,
            "z": -0.943
          },
          "size": {
            "x": 0.829,
            "z": 0.924
          },
          "height": 1.739
        },
        {
          "id": "box-12",
          "center": {
            "x": 14.973,
            "z": 5.001
          },
          "size": {
            "x": 1.118,
            "z": 1.296
          },
          "height": 0.7
        },
        {
          "id": "box-13",
          "center": {
            "x": -4.968,
            "z": 3.1
          },
          "size": {
            "x": 1.166,
            "z": 0.989
          },
          "height": 0.928
        },
        {
          "id": "box-14",
          "center": {
            "x": 7.072,
            "z": 1.057
          },
          "size": {
            "x": 1.067,
            "z": 1.133
          },
          "height": 0.772
        },
        {
          "id": "box-15",
          "center": {
            "x": -1.207,
            "z": -2.992
          },
          "size": {
            "x": 0.877,
            "z": 1.033
          },
          "height": 1.788
        },
        {
          "id": "box-16",
          "center": {
            "x": 8.967,
            "z": -9.098
          },
          "size": {
            "x": 0.985,
            "z": 1.023
          },
          "height": 2.051
        },
        {
          "id": "box-17",
          "center": {
            "x": -12.991,
            "z": 5.021
          },
          "size": {
            "x": 0.948,
            "z": 1.256
          },
          "height": 1.356
        },
        {
          "id": "box-18",
          "center": {
            "x": 8.863,
            "z": -2.783
          },
          "size": {
            "x": 1.019,
            "z": 0.835
          },
          "height": 1.694
        },
        {
          "id": "box-19",
          "center": {
            "x": -14.984,
            "z": -9.017
          },
          "size": {
            "x": 1.181,
            "z": 1.228
          },
          "height": 0.649
        },
        {
          "id": "box-20",
          "center": {
            "x": 11.003,
            "z": 3.111
          },
          "size": {
            "x": 1.263,
            "z": 1.07
          },
          "height": 1.178
        },
        {
          "id": "box-21",
          "center": {
            "x": 5.002,
            "z": 1.014
          },
          "size": {
            "x": 1.226,
            "z": 1.226
          },
          "height": 2.099
        },
        {
          "id": "box-22",
          "center": {
            "x": -7.004,
            "z": 1.113
          },
          "size": {
            "x": 1.239,
            "z": 0.97
          },
          "height": 1.898
        },
        {
          "id": "box-23",
          "center": {
            "x": 4.862,
            "z": 10.891
          },
          "size": {
            "x": 1.023,
            "z": 1.042
          },
          "height": 1.152
        },
        {
          "id": "box-24",
          "center": {
            "x": -8.93,
            "z": 4.889
          },
          "size": {
            "x": 0.936,
            "z": 1.035
          },
          "height": 1.776
        },
        {
          "id": "box-25",
          "center": {
            "x": 12.924,
            "z": 1
          },
          "size": {
            "x": 0.803,
            "z": 0.961
          },
          "height": 2.393
        },
        {
          "id": "box-26",
          "center": {
            "x": -6.948,
            "z": 5.053
          },
          "size": {
            "x": 1.136,
            "z": 1.179
          },
          "height": 2.343
        },
        {
          "id": "box-27",
          "center": {
            "x": -0.996,
            "z": -6.989
          },
          "size": {
            "x": 1.29,
            "z": 1.217
          },
          "height": 1.322
        },
        {
          "id": "box-28",
          "center": {
            "x": -12.92,
            "z": -8.947
          },
          "size": {
            "x": 0.967,
            "z": 1.141
          },
          "height": 1.427
        },
        {
          "id": "box-29",
          "center": {
            "x": 9.024,
            "z": 11.084
          },
          "size": {
            "x": 1.248,
            "z": 0.956
          },
          "height": 1.296
        },
        {
          "id": "box-30",
          "center": {
            "x": 13.157,
            "z": 6.923
          },
          "size": {
            "x": 0.815,
            "z": 1.137
          },
          "height": 1.021
        },
        {
          "id": "box-31",
          "center": {
            "x": 8.965,
            "z": -15.007
          },
          "size": {
            "x": 1.157,
            "z": 1.276
          },
          "height": 1.863
        },
        {
          "id": "box-32",
          "center": {
            "x": 12.957,
            "z": 9.15
          },
          "size": {
            "x": 0.922,
            "z": 0.977
          },
          "height": 0.81
        }
      ],
      "platforms": [
        {
          "id": "plat-1",
          "center": {
            "x": 2,
            "z": -4
          },
          "size": {
            "x": 3.3,
            "z": 3.3
          }
        },
        {
          "id": "plat-2",
          "center": {
            "x": 6,
            "z": -10
          },
          "size": {
            "x": 3.3,
            "z": 3.3
          }
        }
      ],
      "ramps": [
        {
          "id": "ramp-1",
          "platform": "plat-1",
          "side": "+z",
          "length": 3.363,
          "width": 1.138,
          "offset": 1
        },
        {
          "id": "ramp-2",
          "platform": "plat-2",
          "side": "-z",
          "length": 3.313,
          "width": 1.22,
          "offset": -1
        }
      ],
      "collectibles": [
        {
          "id": "gem-1",
          "position": {
            "x": -15,
            "z": -5
          }
        },
        {
          "id": "gem-2",
          "position": {
            "x": 15,
            "z": -5
          }
        },
        {
          "id": "gem-3",
          "position": {
            "x": -15,
            "z": 15
          }
        },
        {
          "id": "gem-4",
          "position": {
            "x": -3,
            "z": -15
          }
        },
        {
          "id": "gem-5",
          "position": {
            "x": -1,
            "z": 15
          }
        }
      ],
      "guards": [
        {
          "id": "guard-1",
          "route": [
            {
              "x": -11,
              "z": 11
            },
            {
              "x": -3,
              "z": 11
            },
            {
              "x": -3,
              "z": 15
            },
            {
              "x": -11,
              "z": 15
            }
          ]
        },
        {
          "id": "guard-2",
          "route": [
            {
              "x": 1,
              "z": 3
            },
            {
              "x": 9,
              "z": 3
            },
            {
              "x": 9,
              "z": 7
            },
            {
              "x": 1,
              "z": 7
            }
          ]
        }
      ],
      "timeLimit": 51,
      "target": 5
    }
  },
  {
    "id": "gen-3",
    "seed": "builtin-gen-3",
    "schemaVersion": 1,
    "generatorVersion": 1,
    "brief": {
      "schemaVersion": 1,
      "tier": "large",
      "density": "mid",
      "platforms": 3,
      "collectibles": 6,
      "distribution": "elevated",
      "guards": 2,
      "patrol": "back-and-forth",
      "intent": "tense",
      "visual": {
        "theme": "snow",
        "time": "night",
        "weather": "rain"
      },
      "title": "雪夜高台",
      "opening": "夜里下着雨，宝石只在高台上。找到坡道，赶在时间用完之前收集齐。",
      "cast": []
    },
    "rules": {
      "timeLimit": 60,
      "target": 6,
      "penaltySeconds": 10,
      "cooldownSeconds": 2
    },
    "layout": {
      "id": "gen-3",
      "name": "雪夜高台",
      "size": {
        "width": 48,
        "depth": 48
      },
      "spawn": {
        "x": 5,
        "z": 15,
        "yaw": 0.71
      },
      "boxes": [
        {
          "id": "box-1",
          "center": {
            "x": -21.025,
            "z": -11.102
          },
          "size": {
            "x": 1.163,
            "z": 0.972
          },
          "height": 1.146
        },
        {
          "id": "box-2",
          "center": {
            "x": -4.982,
            "z": -1.039
          },
          "size": {
            "x": 1.147,
            "z": 1.186
          },
          "height": 0.712
        },
        {
          "id": "box-3",
          "center": {
            "x": -18.947,
            "z": -19.085
          },
          "size": {
            "x": 0.992,
            "z": 0.932
          },
          "height": 1.051
        },
        {
          "id": "box-4",
          "center": {
            "x": 2.995,
            "z": 9.14
          },
          "size": {
            "x": 1.28,
            "z": 0.966
          },
          "height": 2.03
        },
        {
          "id": "box-5",
          "center": {
            "x": 16.927,
            "z": 13.005
          },
          "size": {
            "x": 0.812,
            "z": 0.921
          },
          "height": 1.528
        },
        {
          "id": "box-6",
          "center": {
            "x": -5.008,
            "z": 15.063
          },
          "size": {
            "x": 1.069,
            "z": 1.095
          },
          "height": 0.98
        },
        {
          "id": "box-7",
          "center": {
            "x": 10.942,
            "z": 7.04
          },
          "size": {
            "x": 1.183,
            "z": 0.963
          },
          "height": 1.445
        },
        {
          "id": "box-8",
          "center": {
            "x": 2.92,
            "z": -3.02
          },
          "size": {
            "x": 1.007,
            "z": 1.165
          },
          "height": 0.606
        },
        {
          "id": "box-9",
          "center": {
            "x": -17.059,
            "z": 1.069
          },
          "size": {
            "x": 0.981,
            "z": 1.147
          },
          "height": 1.701
        },
        {
          "id": "box-10",
          "center": {
            "x": -20.997,
            "z": 21.069
          },
          "size": {
            "x": 1.15,
            "z": 0.859
          },
          "height": 0.696
        },
        {
          "id": "box-11",
          "center": {
            "x": 1.113,
            "z": 6.977
          },
          "size": {
            "x": 0.98,
            "z": 1.175
          },
          "height": 2.336
        },
        {
          "id": "box-12",
          "center": {
            "x": 11.006,
            "z": -3.025
          },
          "size": {
            "x": 1.267,
            "z": 0.865
          },
          "height": 1.229
        },
        {
          "id": "box-13",
          "center": {
            "x": -12.994,
            "z": 4.977
          },
          "size": {
            "x": 1.224,
            "z": 0.93
          },
          "height": 1.521
        },
        {
          "id": "box-14",
          "center": {
            "x": -6.817,
            "z": 8.938
          },
          "size": {
            "x": 0.864,
            "z": 1.014
          },
          "height": 1.236
        },
        {
          "id": "box-15",
          "center": {
            "x": -16.988,
            "z": -14.853
          },
          "size": {
            "x": 1.272,
            "z": 0.974
          },
          "height": 1.774
        },
        {
          "id": "box-16",
          "center": {
            "x": -8.92,
            "z": -21.072
          },
          "size": {
            "x": 0.85,
            "z": 1.116
          },
          "height": 0.846
        },
        {
          "id": "box-17",
          "center": {
            "x": -4.987,
            "z": 9.047
          },
          "size": {
            "x": 1.122,
            "z": 0.928
          },
          "height": 0.96
        },
        {
          "id": "box-18",
          "center": {
            "x": 2.949,
            "z": 1.115
          },
          "size": {
            "x": 1.132,
            "z": 0.855
          },
          "height": 1.608
        },
        {
          "id": "box-19",
          "center": {
            "x": -13.103,
            "z": 7.026
          },
          "size": {
            "x": 1.02,
            "z": 1.142
          },
          "height": 1.713
        },
        {
          "id": "box-20",
          "center": {
            "x": -8.968,
            "z": 18.988
          },
          "size": {
            "x": 1.23,
            "z": 1.063
          },
          "height": 2.341
        },
        {
          "id": "box-21",
          "center": {
            "x": -2.967,
            "z": 9.002
          },
          "size": {
            "x": 1.22,
            "z": 0.914
          },
          "height": 1.759
        },
        {
          "id": "box-22",
          "center": {
            "x": 12.982,
            "z": -19.048
          },
          "size": {
            "x": 1.059,
            "z": 0.86
          },
          "height": 1.716
        },
        {
          "id": "box-23",
          "center": {
            "x": 0.929,
            "z": -1.164
          },
          "size": {
            "x": 0.859,
            "z": 0.89
          },
          "height": 1.082
        },
        {
          "id": "box-24",
          "center": {
            "x": 5.013,
            "z": 7.003
          },
          "size": {
            "x": 1.071,
            "z": 1.21
          },
          "height": 1.841
        },
        {
          "id": "box-25",
          "center": {
            "x": -21.06,
            "z": 16.942
          },
          "size": {
            "x": 1.127,
            "z": 1.067
          },
          "height": 0.831
        },
        {
          "id": "box-26",
          "center": {
            "x": 14.838,
            "z": -16.773
          },
          "size": {
            "x": 0.932,
            "z": 0.807
          },
          "height": 2.225
        },
        {
          "id": "box-27",
          "center": {
            "x": -18.974,
            "z": 13.016
          },
          "size": {
            "x": 1.018,
            "z": 1.265
          },
          "height": 1.822
        },
        {
          "id": "box-28",
          "center": {
            "x": -3.027,
            "z": 18.905
          },
          "size": {
            "x": 0.914,
            "z": 0.949
          },
          "height": 1.059
        },
        {
          "id": "box-29",
          "center": {
            "x": -19.001,
            "z": 5.085
          },
          "size": {
            "x": 1.298,
            "z": 0.872
          },
          "height": 1.254
        },
        {
          "id": "box-30",
          "center": {
            "x": 9.111,
            "z": -19.093
          },
          "size": {
            "x": 0.934,
            "z": 1.042
          },
          "height": 1.75
        },
        {
          "id": "box-31",
          "center": {
            "x": -16.973,
            "z": 10.894
          },
          "size": {
            "x": 1.112,
            "z": 1.071
          },
          "height": 0.757
        },
        {
          "id": "box-32",
          "center": {
            "x": 5.029,
            "z": -2.814
          },
          "size": {
            "x": 1.168,
            "z": 0.822
          },
          "height": 1.253
        },
        {
          "id": "box-33",
          "center": {
            "x": -15.161,
            "z": -8.894
          },
          "size": {
            "x": 0.831,
            "z": 1.016
          },
          "height": 1.925
        },
        {
          "id": "box-34",
          "center": {
            "x": 4.983,
            "z": -15.04
          },
          "size": {
            "x": 1.247,
            "z": 0.87
          },
          "height": 1.564
        },
        {
          "id": "box-35",
          "center": {
            "x": -7.197,
            "z": 3.031
          },
          "size": {
            "x": 0.863,
            "z": 0.984
          },
          "height": 1.453
        },
        {
          "id": "box-36",
          "center": {
            "x": -9.093,
            "z": 6.999
          },
          "size": {
            "x": 1.072,
            "z": 1.289
          },
          "height": 1.66
        },
        {
          "id": "box-37",
          "center": {
            "x": 12.989,
            "z": 16.937
          },
          "size": {
            "x": 1.236,
            "z": 1.135
          },
          "height": 1.593
        },
        {
          "id": "box-38",
          "center": {
            "x": -0.923,
            "z": 7.18
          },
          "size": {
            "x": 1.104,
            "z": 0.927
          },
          "height": 2.275
        },
        {
          "id": "box-39",
          "center": {
            "x": -20.769,
            "z": 13.073
          },
          "size": {
            "x": 0.813,
            "z": 0.912
          },
          "height": 1.343
        },
        {
          "id": "box-40",
          "center": {
            "x": -0.943,
            "z": -11.129
          },
          "size": {
            "x": 1.062,
            "z": 1.035
          },
          "height": 2.321
        },
        {
          "id": "box-41",
          "center": {
            "x": -3.01,
            "z": 12.987
          },
          "size": {
            "x": 1.263,
            "z": 1.224
          },
          "height": 1.26
        },
        {
          "id": "box-42",
          "center": {
            "x": -5,
            "z": -21.111
          },
          "size": {
            "x": 1.271,
            "z": 0.823
          },
          "height": 0.992
        },
        {
          "id": "box-43",
          "center": {
            "x": 15.003,
            "z": 14.997
          },
          "size": {
            "x": 1.189,
            "z": 1.268
          },
          "height": 2.219
        },
        {
          "id": "box-44",
          "center": {
            "x": 6.92,
            "z": 19.094
          },
          "size": {
            "x": 1.067,
            "z": 1.047
          },
          "height": 1.543
        },
        {
          "id": "box-45",
          "center": {
            "x": -3.004,
            "z": -14.958
          },
          "size": {
            "x": 1.286,
            "z": 1.145
          },
          "height": 1.941
        },
        {
          "id": "box-46",
          "center": {
            "x": 0.848,
            "z": 10.861
          },
          "size": {
            "x": 0.987,
            "z": 0.858
          },
          "height": 1.486
        },
        {
          "id": "box-47",
          "center": {
            "x": 13.136,
            "z": -0.848
          },
          "size": {
            "x": 0.936,
            "z": 0.926
          },
          "height": 2.263
        },
        {
          "id": "box-48",
          "center": {
            "x": -2.945,
            "z": -8.887
          },
          "size": {
            "x": 1.181,
            "z": 0.825
          },
          "height": 0.623
        },
        {
          "id": "box-49",
          "center": {
            "x": -15.074,
            "z": -11.087
          },
          "size": {
            "x": 1.07,
            "z": 1.1
          },
          "height": 0.881
        },
        {
          "id": "box-50",
          "center": {
            "x": -16.988,
            "z": 5.038
          },
          "size": {
            "x": 1.251,
            "z": 1.22
          },
          "height": 2.206
        },
        {
          "id": "box-51",
          "center": {
            "x": 20.994,
            "z": -2.993
          },
          "size": {
            "x": 1.039,
            "z": 1.273
          },
          "height": 2.109
        },
        {
          "id": "box-52",
          "center": {
            "x": 4.83,
            "z": -1.094
          },
          "size": {
            "x": 0.875,
            "z": 0.9
          },
          "height": 1.115
        },
        {
          "id": "box-53",
          "center": {
            "x": -4.971,
            "z": -11.055
          },
          "size": {
            "x": 1.109,
            "z": 1.173
          },
          "height": 1.137
        },
        {
          "id": "box-54",
          "center": {
            "x": 1.015,
            "z": 19.021
          },
          "size": {
            "x": 1.244,
            "z": 1.193
          },
          "height": 1.809
        },
        {
          "id": "box-55",
          "center": {
            "x": -3.016,
            "z": -12.917
          },
          "size": {
            "x": 1.19,
            "z": 0.945
          },
          "height": 1.561
        },
        {
          "id": "box-56",
          "center": {
            "x": -4.999,
            "z": -16.836
          },
          "size": {
            "x": 1.275,
            "z": 0.891
          },
          "height": 0.884
        },
        {
          "id": "box-57",
          "center": {
            "x": 14.922,
            "z": 5.021
          },
          "size": {
            "x": 0.834,
            "z": 0.94
          },
          "height": 2.085
        },
        {
          "id": "box-58",
          "center": {
            "x": -6.996,
            "z": -5.022
          },
          "size": {
            "x": 0.865,
            "z": 1.12
          },
          "height": 1.811
        },
        {
          "id": "box-59",
          "center": {
            "x": 6.949,
            "z": -12.987
          },
          "size": {
            "x": 1.16,
            "z": 1.233
          },
          "height": 0.943
        },
        {
          "id": "box-60",
          "center": {
            "x": -10.794,
            "z": -9.086
          },
          "size": {
            "x": 0.875,
            "z": 1.033
          },
          "height": 1.507
        }
      ],
      "platforms": [
        {
          "id": "plat-1",
          "center": {
            "x": -16,
            "z": -6
          },
          "size": {
            "x": 3.3,
            "z": 3.3
          }
        },
        {
          "id": "plat-2",
          "center": {
            "x": 10,
            "z": 20
          },
          "size": {
            "x": 3.3,
            "z": 3.3
          }
        },
        {
          "id": "plat-3",
          "center": {
            "x": 16,
            "z": 18
          },
          "size": {
            "x": 3.3,
            "z": 3.3
          }
        }
      ],
      "ramps": [
        {
          "id": "ramp-1",
          "platform": "plat-1",
          "side": "-x",
          "length": 2.799,
          "width": 1.281,
          "offset": -1
        },
        {
          "id": "ramp-2",
          "platform": "plat-2",
          "side": "-x",
          "length": 2.699,
          "width": 1.215,
          "offset": 1
        },
        {
          "id": "ramp-3",
          "platform": "plat-3",
          "side": "+x",
          "length": 2.608,
          "width": 1.264,
          "offset": -1
        }
      ],
      "collectibles": [
        {
          "id": "gem-1",
          "position": {
            "x": -16.7,
            "z": -6
          }
        },
        {
          "id": "gem-2",
          "position": {
            "x": -15.3,
            "z": -6
          }
        },
        {
          "id": "gem-3",
          "position": {
            "x": 9.3,
            "z": 20
          }
        },
        {
          "id": "gem-4",
          "position": {
            "x": 10.7,
            "z": 20
          }
        },
        {
          "id": "gem-5",
          "position": {
            "x": 15.3,
            "z": 18
          }
        },
        {
          "id": "gem-6",
          "position": {
            "x": 16.7,
            "z": 18
          }
        }
      ],
      "guards": [
        {
          "id": "guard-1",
          "route": [
            {
              "x": 21,
              "z": 1
            },
            {
              "x": 17,
              "z": 1
            },
            {
              "x": 17,
              "z": 5
            },
            {
              "x": 17,
              "z": 1
            }
          ]
        },
        {
          "id": "guard-2",
          "route": [
            {
              "x": 19,
              "z": -1
            },
            {
              "x": 15,
              "z": -1
            },
            {
              "x": 15,
              "z": -11
            },
            {
              "x": 15,
              "z": -1
            }
          ]
        }
      ],
      "timeLimit": 60,
      "target": 6
    }
  }
];
