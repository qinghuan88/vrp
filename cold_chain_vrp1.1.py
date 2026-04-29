import pandas as pd
import numpy as np
import math
from ortools.constraint_solver import routing_enums_pb2, pywrapcp
import matplotlib.pyplot as plt
import matplotlib
import warnings
warnings.filterwarnings('ignore')
matplotlib.rcParams['font.sans-serif'] = ['SimHei']
matplotlib.rcParams['axes.unicode_minus'] = False

def load_and_validate_data(excel_path="input_data.xlsx"):
    try:
        params_df = pd.read_excel(excel_path, sheet_name="基础参数", index_col=0)
        nodes_df = pd.read_excel(excel_path, sheet_name="网点信息")
        vehicles_df = pd.read_excel(excel_path, sheet_name="车辆信息")
        
        params = {
            'c0': float(params_df.loc['c0', '参数值']),
            'c1': float(params_df.loc['c1', '参数值']),
            'c2': float(params_df.loc['c2', '参数值']),
            'Q_max': float(params_df.loc['Q_max', '参数值']),
            'v_avg': float(params_df.loc['v_avg', '参数值']),
            'T_max': float(params_df.loc['T_max', '参数值']),
            'buffer': float(params_df.loc['time_window_buffer', '参数值'])
        }
        
        if 0 not in nodes_df['节点ID'].values:
            raise ValueError("❌ 错误：网点信息中缺少节点ID=0（配送中心）")
        if nodes_df['网点类型'].value_counts().get('需求点', 0) == 0:
            raise ValueError("❌ 错误：未检测到任何需求点（网点类型需含'需求点'）")
        if nodes_df['时间窗开始'].isnull().any() or nodes_df['时间窗结束'].isnull().any():
            raise ValueError("❌ 错误：存在时间窗为空的网点")
        
        nodes_df = nodes_df.sort_values('节点ID').reset_index(drop=True)
        depot_idx = nodes_df[nodes_df['节点ID'] == 0].index[0]
        if depot_idx != 0:
            nodes_df = pd.concat([nodes_df.iloc[[depot_idx]], nodes_df.drop(depot_idx)]).reset_index(drop=True)
        
        available_vehicles = vehicles_df[vehicles_df['状态'] == '可用']
        if len(available_vehicles) == 0:
            raise ValueError("❌ 错误：无可用车辆（车辆信息表中'状态'需含'可用'）")
        
        print(f"✅ 数据加载成功 | 需求点: {len(nodes_df[nodes_df['网点类型'] == '需求点'])} | 可用车辆: {len(available_vehicles)}")
        return params, nodes_df, available_vehicles
    except Exception as e:
        print(f"❌ 数据加载失败: {str(e)}")
        raise

def safe_parse_time(time_str):
    """安全解析时间字符串为分钟数（修复 24:00 问题）"""
    time_str = str(time_str).strip()
    if ':' not in time_str:
        raise ValueError(f"无效时间格式: {time_str} (应为 HH:MM)")
    
    # 特殊处理 24:00
    if time_str.upper() == "24:00":
        return 24 * 60  # 1440分钟
    
    try:
        parts = time_str.split(':')
        hour = int(parts[0])
        minute = int(parts[1]) if len(parts) > 1 else 0
        
        if hour < 0 or hour > 24 or minute < 0 or minute >= 60:
            raise ValueError(f"无效时间: {time_str}")
        
        # 24:00 应表示为 00:00 第二天
        if hour == 24 and minute > 0:
            raise ValueError(f"无效时间: {time_str} (24小时制最大为 24:00)")
        
        return hour * 60 + minute
    except Exception as e:
        raise ValueError(f"时间解析错误 '{time_str}': {str(e)}")

def create_distance_time_matrix(nodes_df, v_avg_kmph):
    n = len(nodes_df)
    dist_mat = np.zeros((n, n))
    time_mat = np.zeros((n, n))
    R = 6371.0  # 地球半径（公里）
    
    for i in range(n):
        for j in range(n):
            if i == j:
                continue
                
            lat1, lon1 = math.radians(nodes_df.iloc[i]['纬度']), math.radians(nodes_df.iloc[i]['经度'])
            lat2, lon2 = math.radians(nodes_df.iloc[j]['纬度']), math.radians(nodes_df.iloc[j]['经度'])
            
            dlon = lon2 - lon1
            dlat = lat2 - lat1
            
            a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
            c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
            distance_km = R * c
            
            dist_mat[i, j] = round(distance_km, 2)
            time_mat[i, j] = round(distance_km / v_avg_kmph * 60, 1)  # 转换为分钟
    
    return dist_mat, time_mat

def solve_vrp(params, nodes_df, vehicles_df, dist_mat, time_mat):
    n_nodes = len(nodes_df)
    n_vehicles = len(vehicles_df)
    depot = 0
    
    # 构建需求和时间数据
    demands = [0 if nodes_df.iloc[i]['网点类型'] == '配送中心' else int(nodes_df.iloc[i]['需求量(kg)']) for i in range(n_nodes)]
    service_times = [0 if nodes_df.iloc[i]['网点类型'] == '配送中心' else float(nodes_df.iloc[i]['服务时长(小时)']) for i in range(n_nodes)]
    
    # 构建时间窗
    time_windows = []
    for i in range(n_nodes):
        try:
            start_str = nodes_df.iloc[i]['时间窗开始']
            end_str = nodes_df.iloc[i]['时间窗结束']
            
            start_min = safe_parse_time(start_str)
            end_min = safe_parse_time(end_str)
            
            buffer_min = int(params['buffer'] * 60)
            start_min = max(0, start_min - buffer_min)
            end_min = min(1440, end_min + buffer_min)  # 1440 = 24*60
            
            if start_min >= end_min:
                raise ValueError(f"无效时间窗 [{start_str}-{end_str}] → ({start_min}-{end_min})")
                
            time_windows.append((start_min, end_min))
        except Exception as e:
            print(f"❌ 节点 {nodes_df.iloc[i]['网点名称']} ({i}) 时间窗错误: {str(e)}")
            raise
    
    # 创建路由管理器
    manager = pywrapcp.RoutingIndexManager(n_nodes, n_vehicles, depot)
    routing = pywrapcp.RoutingModel(manager)
    
    # 定义成本函数（距离+时间）
    def combined_cost_callback(from_idx, to_idx):
        from_node = manager.IndexToNode(from_idx)
        to_node = manager.IndexToNode(to_idx)
        dist = dist_mat[from_node][to_node]
        time_hr = time_mat[from_node][to_node] / 60  # 转换为小时
        cost = params['c1'] * dist + params['c2'] * time_hr
        return int(cost * 100)  # 转换为整数避免浮点误差
    
    transit_callback_index = routing.RegisterTransitCallback(combined_cost_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)
    
    # 定义时间回调
    def time_callback(from_idx, to_idx):
        from_node = manager.IndexToNode(from_idx)
        to_node = manager.IndexToNode(to_idx)
        return int(time_mat[from_node][to_node])  # 分钟
    
    time_callback_index = routing.RegisterTransitCallback(time_callback)
    
    # 定义需求回调
    def demand_callback(from_idx):
        return demands[manager.IndexToNode(from_idx)]
    
    demand_callback_index = routing.RegisterUnaryTransitCallback(demand_callback)
    routing.AddDimensionWithVehicleCapacity(
        demand_callback_index,
        0,  # 无松弛
        [int(params['Q_max'])] * n_vehicles,  # 车辆容量
        True,  # 固定起点
        "Capacity"
    )
    
    # 添加时间维度
    routing.AddDimension(
        time_callback_index,
        30,  # 30分钟等待时间上限
        int(24 * 60),  # 24小时（分钟）
        False,  # 不固定起点
        "Time"
    )
    time_dimension = routing.GetDimensionOrDie("Time")
    
    # 设置时间窗约束
    for i in range(n_nodes):
        index = manager.NodeToIndex(i)
        time_dimension.CumulVar(index).SetRange(time_windows[i][0], time_windows[i][1])
    
    # 设置服务时间（松弛变量）
    for i in range(1, n_nodes):  # 跳过配送中心
        index = manager.NodeToIndex(i)
        time_dimension.SlackVar(index).SetValue(int(service_times[i] * 60))  # 转换为分钟
    
    # 设置车辆固定成本
    routing.SetFixedCostOfAllVehicles(int(params['c0'] * 100))
    
    # 配置搜索参数
    search_parameters = pywrapcp.DefaultRoutingSearchParameters()
    search_parameters.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    )
    search_parameters.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    search_parameters.time_limit.seconds = 600
    search_parameters.log_search = False
    
    print("🔍 正在求解优化模型（最多600秒）...")
    solution = routing.SolveWithParameters(search_parameters)
    
    if not solution:
        raise Exception("❌ 优化失败：无可行解。请检查时间窗是否过紧、车辆是否不足或载重是否超限。")
    
    return solution, routing, manager, time_dimension, demands, service_times

def print_solution(params, solution, routing, manager, nodes_df, vehicles_df, time_dimension, demands, service_times, dist_mat, time_mat):
    """打印解决方案并返回结构化数据"""
    total_distance = 0
    total_time = 0
    total_cost = 0
    used_vehicles = 0
    route_details = []
    depot = 0
    
    print("\n" + "="*60)
    print(f"🚚 优化结果报告 | 日期: 2026-03-13")
    print("="*60)
    
    for vehicle_id in range(len(vehicles_df)):
        index = routing.Start(vehicle_id)
        if routing.IsEnd(solution.Value(routing.NextVar(index))):
            continue
            
        used_vehicles += 1
        route_distance = 0
        route_time = 0
        total_load = 0
        total_route_cost = 0
        node_list = [depot]
        time_list = []
        load_list = []
        
        # 获取起始时间（从配送中心出发时间）
        start_time = time_dimension.CumulVar(index).Min()
        current_time = start_time
        current_load = 0
        
        while not routing.IsEnd(index):
            node_index = manager.IndexToNode(index)
            next_index = solution.Value(routing.NextVar(index))
            next_node = manager.IndexToNode(next_index)
            
            # 累加载重
            if node_index != depot:
                current_load += demands[node_index]
                total_load += demands[node_index]
            
            # 累加距离
            dist = dist_mat[node_index][next_node]
            route_distance += dist
            
            # 累加时间
            time_val = time_mat[node_index][next_node]
            route_time += time_val / 60  # 转换为小时
            
            # 累加成本
            cost_segment = params['c1'] * dist + params['c2'] * (time_val / 60)
            total_route_cost += cost_segment
            
            # 记录节点
            if next_node != depot:  # 不记录最后返回配送中心
                node_list.append(next_node)
            
            # 更新当前时间
            current_time += time_val + (service_times[next_node] * 60 if next_node != depot else 0)
            
            index = next_index
        
        node_list.append(depot)  # 添加返回配送中心
        
        # 计算总时间（小时）
        total_route_time_hr = route_time + sum(service_times[node] for node in node_list if node != depot)
        
        # 计算车辆总成本（固定成本+行驶成本+制冷成本）
        vehicle_cost = params['c0'] + total_route_cost
        
        total_distance += route_distance
        total_time += total_route_time_hr
        total_cost += vehicle_cost
        
        # === 构建结构化数据（修正版）===
        route_info = {
            'vehicle_id': vehicle_id + 1,
            'plate': vehicles_df.iloc[vehicle_id]['车牌号'],
            'nodes': node_list,
            'distance': round(route_distance, 2),
            'drive_time': round(route_time, 2),
            'total_time': round(total_route_time_hr, 2),
            'cost': round(vehicle_cost, 2),
            'peak_load': total_load
        }
        route_details.append(route_info)
        
        # 打印车辆路线详情
        print(f"\n【车辆{vehicle_id+1}】{vehicles_df.iloc[vehicle_id]['车牌号']}")
        print(f" 路线: {' → '.join(str(n) for n in node_list)}")
        print(f" 节点: {' → '.join(nodes_df.iloc[n]['网点名称'] for n in node_list)}")
        print(f" 载重: {total_load}kg/{params['Q_max']}kg | 距离: {route_distance:.2f}km")
        print(f" 时间: {total_route_time_hr:.1f}h (限{params['T_max']}h) | 成本: ¥{vehicle_cost:.2f}")
        print(f" ⚠️ 注意: 全程保持2~8℃ | 服务时长{service_times[1]*60:.0f}分钟/点")
    
    # ===== 导出Excel核心代码（2026-03-13 版）=====
    try:
        import pandas as pd
        from datetime import datetime
        import os
        
        # 创建路线详情DataFrame
        excel_data = []
        for r in route_details:
            node_names = [nodes_df.iloc[n]['网点名称'] for n in r['nodes']]
            excel_data.append({
                '车辆编号': f"车辆{r['vehicle_id']}",
                '车牌号': r['plate'],
                '路线节点': " → ".join(str(n) for n in r['nodes']),
                '途经网点': " → ".join(node_names),
                '途经网点数': len(r['nodes']) - 2,  # 排除起点终点
                '总载重(kg)': r['peak_load'],
                '最大载重(kg)': params['Q_max'],
                '行驶距离(km)': r['distance'],
                '驾驶时长(h)': r['drive_time'],
                '总耗时(h)': r['total_time'],
                '时间限制(h)': params['T_max'],
                '路线成本(¥)': r['cost'],
                '冷链温度': '2~8℃',
                '时间窗合规': '✅ 合规' if r['total_time'] <= params['T_max'] else '⚠️ 超时'
            })
        
        df = pd.DataFrame(excel_data)
        
        # 创建汇总数据
        summary = {
            '车辆编号': '【汇总】',
            '车牌号': f"共{len(route_details)}辆车",
            '路线节点': '',
            '途经网点': '',
            '途经网点数': df['途经网点数'].sum() if not df.empty else 0,
            '总载重(kg)': df['总载重(kg)'].sum() if not df.empty else 0,
            '最大载重(kg)': '',
            '行驶距离(km)': df['行驶距离(km)'].sum() if not df.empty else 0,
            '驾驶时长(h)': df['驾驶时长(h)'].sum() if not df.empty else 0,
            '总耗时(h)': df['总耗时(h)'].max() if not df.empty else 0,
            '时间限制(h)': params['T_max'],
            '路线成本(¥)': df['路线成本(¥)'].sum() if not df.empty else 0,
            '冷链温度': '全程2~8℃',
            '时间窗合规': ''
        }
        
        # 添加模拟日期信息到汇总行
        summary['车牌号'] = f"{summary['车牌号']} | 模拟日期: 2026-03-13"
        summary['路线成本(¥)'] = f"总成本: ¥{total_cost:,.2f}"
        
        # 合并数据
        df = pd.concat([df, pd.DataFrame([summary])], ignore_index=True)
        
        # 导出Excel
        output_file = 'cold_chain_routes_2026-03-13.xlsx'
        with pd.ExcelWriter(output_file, engine='openpyxl') as writer:
            df.to_excel(writer, sheet_name='2026-03-13 配送路线', index=False)
            
            # 优化列宽
            worksheet = writer.sheets['2026-03-13 配送路线']
            for idx, col in enumerate(df.columns, 1):
                max_len = max(
                    df[col].astype(str).map(len).max() if not df.empty else len(col),
                    len(col)
                ) + 2
                worksheet.column_dimensions[chr(64+idx)].width = min(max_len, 25)
        
        print(f"\n✅ 路线详情已导出: {output_file}")
        print(f"   📁 位置: {os.path.abspath(output_file)}")
        print(f"   📅 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
        
    except ImportError as e:
        print(f"\n⚠️ Excel导出跳过（缺少库）: {str(e)}")
        print("   安装命令: pip install openpyxl pandas")
    except Exception as e:
        print(f"\n⚠️ Excel导出异常（不影响主流程）: {type(e).__name__}: {str(e)}")
    
    # 打印汇总统计
    print("\n" + "="*60)
    print(f"📊 汇总统计 | 使用车辆: {used_vehicles}/{len(vehicles_df)} | 总里程: {total_distance:.1f}km | 总耗时: {total_time:.1f}h")
    print(f"💰 成本分解: 固定成本 ¥{used_vehicles * params['c0']:.2f} | 行驶成本 ¥{params['c1'] * total_distance:.2f} | 制冷成本 ¥{params['c2'] * total_time:.2f}")
    print(f"🎯 总成本: ¥{total_cost:,.2f} | ")
    print("="*60)
    
    return route_details

def plot_routes(nodes_df, route_details, save_path="cold_chain_route_map_20260313.png"):
    plt.figure(figsize=(12, 10))
    
    # 绘制配送中心
    depot = nodes_df[nodes_df['节点ID'] == 0].iloc[0]
    plt.scatter(depot['经度'], depot['纬度'], 
               s=300, c='gold', marker='*', edgecolors='black', linewidths=1.5,
               label='配送中心', zorder=10)
    
    # 绘制需求点
    demands = nodes_df[nodes_df['网点类型'] == '需求点']
    plt.scatter(demands['经度'], demands['纬度'], 
               s=150, c='skyblue', edgecolors='navy', linewidths=1,
               label='需求点')
    
    # 添加网点名称标签
    for _, row in nodes_df.iterrows():
        plt.text(row['经度'] + 0.001, row['纬度'] + 0.001, 
                row['网点名称'], fontsize=9, alpha=0.8)
    
    # 生成颜色序列
    colors = plt.cm.tab10(np.linspace(0, 1, len(route_details)))
    
    # 绘制每条路线
    for i, route in enumerate(route_details):
        coords = [(nodes_df.iloc[n]['经度'], nodes_df.iloc[n]['纬度']) for n in route['nodes']]
        xs, ys = zip(*coords)
        
        plt.plot(xs, ys, 
                marker='o', 
                color=colors[i], 
                linewidth=2, 
                label=f"车辆{route['vehicle_id']} ({route['plate']})",
                alpha=0.8)
    
    # 设置图表样式
    plt.title('冷链药品配送优化路线图 (2026-03-13)', fontsize=16, fontweight='bold')
    plt.xlabel('经度', fontsize=12)
    plt.ylabel('纬度', fontsize=12)
    plt.legend(loc='best', fontsize=10)
    plt.grid(True, linestyle='--', alpha=0.3)
    plt.tight_layout()
    
    # 保存并关闭
    plt.savefig(save_path, dpi=150)
    print(f"✅ 路线图已保存至: {save_path}")
    plt.close()

def main():
    try:
        # 加载数据
        params, nodes_df, vehicles_df = load_and_validate_data("input_data.xlsx")
        
        # 创建距离和时间矩阵
        dist_mat, time_mat = create_distance_time_matrix(nodes_df, params['v_avg'])
        print(f"📍 已生成 {len(nodes_df)}x{len(nodes_df)} 距离/时间矩阵（欧氏距离近似）")
        
        # 求解VRP问题
        solution, routing, manager, time_dimension, demands, service_times = solve_vrp(
            params, nodes_df, vehicles_df, dist_mat, time_mat
        )
        
        # 打印解决方案并获取路线详情
        route_details = print_solution(
            params, solution, routing, manager, nodes_df, vehicles_df, 
            time_dimension, demands, service_times, dist_mat, time_mat
        )
        
        # 绘制路线图
        plot_routes(nodes_df, route_details, "cold_chain_route_map_2026-03-13.png")
        
        # 打印司机任务单示例
        print("\n📄 司机任务单示例（车辆1）:")
        print("-" * 40)
        if route_details:
            r = route_details[0]
            print(f"车牌: {r['plate']} | 任务日期: 2026-03-13")
            print(f"今日任务: {len(r['nodes']) - 2}个站点 | 出发时间: 08:00")
            estimated_return = 8 + r['total_time']
            print(f"预计返回: {int(estimated_return)}:{int((estimated_return % 1) * 60):02d}")
            print(f"路线: " + " → ".join([nodes_df.iloc[n]['网点名称'] for n in r['nodes']]))
            print(f"⚠️ 注意: 全程保持2~8℃ | 单点服务时长约{service_times[r['nodes'][1]] * 60:.0f}分钟")
        print("-" * 40)
        
         print(" 1. 将路线图发送至司机手机")
        print(" 2. 在TMS系统中导入Excel路线数据")
        print(" 3. 配置车载温控设备实时监控（2~8℃）")
        
    except Exception as e:
        print(f"\n❌ 程序执行出错: {str(e)}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    print("=" * 60)
    print("❄️ 冷链药品配送智能优化系统 v1.1 ")
    print(" 基于数学模型: min Z = m·c0 + c1·ΣL_ij·x_ijk + c2·Σt_ij·x_ijk")
    print(" 温度要求: 2~8℃")
    print("=" * 60)
    main()